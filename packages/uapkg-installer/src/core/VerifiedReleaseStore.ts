import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveActiveUapkgProfileRoot } from '@uapkg/common';
import { PackageNameSchema, PackageVersionSchema, type PackageName, type PackageVersion } from '@uapkg/common-schema';
import type { LockDependency } from '@uapkg/package-manifest-schema';
import { extract } from 'tar';
import type { VerifiedRelease } from '#installer/contracts/InstallerTypes.ts';

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return 'sha256:' + hash.digest('hex');
}

function receiptPath(workspace: string, packageName: string): string {
  const key = createHash('sha256').update(packageName).digest('hex');
  return join(workspace, '.uapkg', 'state', 'installed', key + '.json');
}

async function physicalLocation(workspace: string, target: string): Promise<string> {
  const info = await lstat(target, { bigint: true });
  if (!info.isDirectory()) throw new Error('Installed package path is no longer a regular directory: ' + target);
  const location = await realpath(target);
  const inside = relative(await realpath(workspace), location);
  if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) {
    throw new Error('Installed package path is outside the workspace: ' + location);
  }
  return JSON.stringify([location, String(info.dev), String(info.ino), String(info.birthtimeNs)]);
}

/** Package code never needs to read or write a receipt. All paths are derived from the current resolution. */
export class VerifiedReleaseStore {
  /** Receipts survive the lockfile changing before a failed or deferred removal can finish. */
  async orphaned(workspace: string, lockedNames: readonly string[]): Promise<Map<PackageName, PackageVersion>> {
    const installed = new Map<PackageName, PackageVersion>();
    const dir = join(workspace, '.uapkg', 'state', 'installed');
    const current = new Set(lockedNames.map((name) => basename(receiptPath(workspace, name))));
    let files;
    try {
      files = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return installed;
      throw error;
    }
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(file.name) || current.has(file.name)) continue;
      if (!file.isFile()) throw new Error('Unexpected installed receipt entry: ' + file.name);
      const saved = JSON.parse(await readFile(join(dir, file.name), 'utf8'));
      const name = PackageNameSchema.parse(saved.packageName);
      const version = PackageVersionSchema.parse(saved.version);
      if (basename(receiptPath(workspace, name)) !== file.name)
        throw new Error('Invalid installed receipt for ' + name);
      installed.set(name, version);
    }
    return installed;
  }

  async canRemove(workspace: string, name: PackageName, installPath: string): Promise<boolean> {
    const target = resolve(workspace, installPath);
    let location: string;
    try {
      location = await physicalLocation(workspace, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    const receipt = JSON.parse(await readFile(receiptPath(workspace, name), 'utf8'));
    if (receipt.packageName !== name || receipt.installedPath !== target || receipt.physicalLocation !== location) {
      throw new Error(
        'The directory at ' +
          target +
          ' is not the installation recorded for this workspace. Its contents were preserved.',
      );
    }
    return true;
  }
  release(
    workspace: string,
    name: string,
    item: LockDependency,
    registryId: string,
    installPath: string,
  ): VerifiedRelease {
    if (!/^sha256:[a-f0-9]{64}$/.test(item.integrity) || !/^[a-f0-9]{64}$/.test(registryId)) {
      throw new Error('Invalid source identity or archive integrity for ' + name);
    }
    return {
      activationId: randomUUID(),
      packageName: name,
      registry: item.registry,
      registryId,
      version: item.version,
      integrity: item.integrity,
      installedPath: resolve(workspace, installPath),
      archivePath: join(
        resolveActiveUapkgProfileRoot(),
        'cache',
        'verified-packages',
        item.integrity.slice(7) + '.tgz',
      ),
      dependencies: Object.keys(item.dependencies ?? {}).sort(),
    };
  }

  async retained(workspace: string, release: VerifiedRelease): Promise<VerifiedRelease | undefined> {
    try {
      const saved = JSON.parse(await readFile(receiptPath(workspace, release.packageName), 'utf8'));
      if (
        saved.registryId === release.registryId &&
        saved.registry === release.registry &&
        saved.version === release.version &&
        saved.integrity === release.integrity &&
        saved.packageName === release.packageName &&
        saved.installedPath === release.installedPath &&
        saved.physicalLocation === (await physicalLocation(workspace, release.installedPath)) &&
        typeof saved.activationId === 'string' &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(saved.activationId) &&
        (await digest(release.archivePath)) === release.integrity
      )
        return { ...release, activationId: saved.activationId };
    } catch {
      return undefined;
    }
  }

  async keepArchive(release: VerifiedRelease, downloaded: string): Promise<void> {
    await mkdir(dirname(release.archivePath), { recursive: true });
    const tmp = release.archivePath + '.' + randomUUID();
    try {
      await copyFile(downloaded, tmp);
      await rename(tmp, release.archivePath);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async record(workspace: string, release: VerifiedRelease): Promise<void> {
    const path = receiptPath(workspace, release.packageName);
    const tmp = path + '.' + randomUUID();
    await mkdir(dirname(path), { recursive: true });
    try {
      const physical = await physicalLocation(workspace, release.installedPath);
      await writeFile(tmp, JSON.stringify({ ...release, physicalLocation: physical }), { mode: 0o600 });
      await rename(tmp, path);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async forget(workspace: string, name: string): Promise<void> {
    await rm(receiptPath(workspace, name), { force: true });
  }

  /** Copy first, then validate and extract those exact bytes into a fresh private directory. */
  async withSnapshot<T>(release: VerifiedRelease, use: (root: string) => Promise<T>): Promise<T> {
    const temp = await mkdtemp(join(tmpdir(), 'uapkg-verified-'));
    try {
      const archive = join(temp, 'release.tgz');
      await copyFile(release.archivePath, archive);
      if ((await digest(archive)) !== release.integrity)
        throw new Error('Verified archive changed for ' + release.packageName);
      const root = join(temp, 'package');
      await mkdir(root);
      let invalid: string | undefined;
      let prefix: string | undefined;
      await extract({
        file: archive,
        cwd: root,
        strip: 1,
        strict: true,
        chmod: false,
        filter: (file, entry) => {
          const segments = file.replace(/\/$/, '').split('/');
          const [top] = segments;
          prefix ??= top;
          if (
            top !== prefix ||
            segments.some((part) => !part || part === '.' || part === '..' || /[\\:\0]/.test(part)) ||
            !('type' in entry) ||
            (entry.type !== 'Directory' && entry.type !== 'File') ||
            (segments.length === 1 && entry.type !== 'Directory')
          ) {
            invalid = file;
            return false;
          }
          return true;
        },
      });
      if (invalid !== undefined) throw new Error('Unsupported entry in verified package snapshot: ' + invalid);
      return await use(root);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}
