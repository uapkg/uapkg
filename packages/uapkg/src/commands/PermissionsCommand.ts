import { LifecyclePolicyResolver } from '@uapkg/config';
import { PackageNameSchema } from '@uapkg/common-schema';
import { CapabilitySchema, ReleasePermissionSchema, type ReleasePermission } from '@uapkg/package-manifest-schema';
import type { CompositionRoot } from '#cli/app/CompositionRoot.ts';
import type { PermissionCommandLine } from '#cli/cli/UAPKGCommandLine.ts';
import { InstallCommand } from '#cli/commands/InstallCommand.ts';
import { resolvePackageRegistry } from '#cli/commands/resolvePackageRegistry.ts';
import { sameRelease, readReleaseEntries } from '@uapkg/lifecycle';
import { WorkspaceRuntime } from '#cli/lifecycle/WorkspaceRuntime.ts';

export class PermissionsCommand {
  constructor(
    private readonly root: CompositionRoot,
    private readonly command: PermissionCommandLine,
  ) {}
  async execute(): Promise<number> {
    const options = this.command;
    try {
      const read = await this.root.packageManifest.readManifest();
      if (!read.ok) throw new Error(read.diagnostics.map((d) => d.message).join('\n'));
      const manifest = read.value;
      const grants = manifest.permissions?.releases ?? [];
      if (options.command === 'permissions' && options.action === 'list') {
        if (!grants.length) process.stdout.write('No workspace release permissions.\n');
        for (const g of grants)
          process.stdout.write(
            `${g.registry}  ${g.packageName}@${g.version}  ${g.capabilities.join(', ') || 'deny'}  ${g.integrity}  ${g.registryId}\n`,
          );
        return 0;
      }
      const name = PackageNameSchema.parse(options.packageName);
      const selection = await resolvePackageRegistry(this.root, manifest, name, options.registry);
      this.root.diagnostics.reportAll(selection.diagnostics);
      if (!selection.ok) return 1;
      const registry = selection.value;
      if (options.command === 'lifecycle-retry') {
        return await new InstallCommand(this.root, {
          force: false,
          frozen: true,
          dryRun: false,
          outputFormat: 'text',
          retry: { packageName: name, capability: options.capability, registry },
        }).execute();
      }
      const resolveRelease = async () => {
        const lock = await this.root.packageManifest.readLockfile();
        if (!lock.ok) throw new Error(lock.diagnostics.map((d) => d.message).join('\n'));
        if (!Object.hasOwn(lock.value.packages, name) || lock.value.packages[name]?.registry !== registry) {
          throw new Error(`No locked release of ${name} from registry ${registry} in this workspace.`);
        }
        const release = await this.root.installer.getVerifiedRelease(lock.value, this.root.cwd, name);
        if (options.action === 'approve') {
          await this.root.installer.withVerifiedSnapshot(release, async (source) => {
            const { entries, selector } = await readReleaseEntries(source);
            if (!entries[options.capability])
              throw new Error(`${name}@${release.version} has no ${options.capability} entry.`);
            if (selector) await new WorkspaceRuntime(this.root).pin(selector);
          });
        }
        return release;
      };
      // Historical grants can be revoked after an upgrade, removal, or alias redirect.
      let saved: ReleasePermission | undefined;
      if (options.action === 'revoke' && (options.integrity || options.registryId)) {
        const matches = grants.filter(
          (g) =>
            g.packageName === name &&
            g.registry === registry &&
            (!options.integrity || g.integrity === options.integrity) &&
            (!options.registryId || g.registryId === options.registryId),
        );
        if (matches.length !== 1)
          throw new Error('Select one saved release using --integrity and --registry-id from uapkg permissions list.');
        saved = matches[0];
      }
      const release = saved ?? (await resolveRelease());
      const existing = grants.find((g) => sameRelease(g, release));
      const inheritAllow =
        options.action === 'revoke' &&
        !existing &&
        new LifecyclePolicyResolver().resolve(this.root.config.getAll(), release.registry) === 'allow';
      const capabilities = new Set(existing?.capabilities ?? (inheritAllow ? CapabilitySchema.options : []));
      if (options.action === 'approve') capabilities.add(options.capability);
      else capabilities.delete(options.capability);
      const grant = ReleasePermissionSchema.parse({
        registry: release.registry,
        registryId: release.registryId,
        packageName: release.packageName,
        version: release.version,
        integrity: release.integrity,
        capabilities: [...capabilities].sort(),
      });
      const releases = [...grants.filter((g) => !sameRelease(g, release)), grant].sort(
        (a, b) =>
          a.registry.localeCompare(b.registry) ||
          a.packageName.localeCompare(b.packageName) ||
          a.version.localeCompare(b.version) ||
          a.integrity.localeCompare(b.integrity),
      );
      const result = await this.root.packageManifest.writeManifest({ ...manifest, permissions: { releases } });
      if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join('\n'));
      process.stdout.write(
        `${options.action === 'approve' ? 'Approved' : 'Revoked'} ${options.capability} for ${release.packageName}@${release.version} from ${release.registry}.\n`,
      );
      return 0;
    } catch (err) {
      this.root.diagnostics.reportOne({
        level: 'error',
        code: 'LIFECYCLE_FAILED',
        message: err instanceof Error ? err.message : String(err),
        data: {},
      });
      return 1;
    }
  }
}
