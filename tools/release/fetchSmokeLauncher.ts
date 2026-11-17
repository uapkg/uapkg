import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLI_ROOT, runChecked } from '../../packages/uapkg/build/EnginePackage.ts';
import {
  artifactName,
  assertExactVersion,
  CHECKSUM_FILE,
  CHECKSUM_SIGNATURE,
  parseChecksums,
  PLATFORMS,
  releaseTag,
} from './ReleaseContract.ts';
import { currentPlatform } from './ReleaseArtifacts.ts';
import { verifyMinisign } from './Minisign.ts';

/** Release qualification uses an existing immutable launcher, independently of website deployment. */
export async function fetchSmokeLauncher(version: string, output: string): Promise<void> {
  assertExactVersion(version);
  const publicKey = process.env.UAPKG_RELEASE_PUBLIC_KEY?.trim();
  if (!publicKey) throw new Error('Launcher qualification requires UAPKG_RELEASE_PUBLIC_KEY.');
  const platform = currentPlatform();
  const archive = artifactName('launcher', version, platform);
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'uapkg-smoke-launcher-'));
  try {
    for (const name of [CHECKSUM_FILE, CHECKSUM_SIGNATURE, archive]) {
      const response = await fetch(
        `https://github.com/uapkg/uapkg/releases/download/${encodeURIComponent(releaseTag('launcher', version))}/${encodeURIComponent(name)}`,
        { signal: AbortSignal.timeout(120_000) },
      );
      if (!response.ok || !response.body)
        throw new Error(
          `Could not download ${name}: HTTP ${response.status}. Publish a launcher for the current platform matrix before qualifying the CLI release.`,
        );
      const limit = name === archive ? 64 * 1024 * 1024 : 64 * 1024;
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > limit) throw new Error(`Download exceeded the qualification limit: ${name}.`);
        chunks.push(chunk);
      }
      writeFileSync(path.join(scratch, name), Buffer.concat(chunks));
    }
    verifyMinisign(
      readFileSync(path.join(scratch, CHECKSUM_FILE)),
      publicKey,
      readFileSync(path.join(scratch, CHECKSUM_SIGNATURE), 'utf8'),
    );
    const checksums = parseChecksums(
      readFileSync(path.join(scratch, CHECKSUM_FILE), 'utf8'),
      'launcher',
      version,
      PLATFORMS,
    );
    if (
      createHash('sha256')
        .update(readFileSync(path.join(scratch, archive)))
        .digest('hex') !== checksums.get(archive)
    )
      throw new Error('Qualification launcher checksum mismatch.');
    const require = createRequire(path.join(CLI_ROOT, 'package.json'));
    const tar = require('tar') as {
      t(options: { file: string; onReadEntry: (entry: { path: string; type: string }) => void }): Promise<void>;
      x(options: { file: string; cwd: string; strict: boolean }): Promise<void>;
    };
    const executable = process.platform === 'win32' ? 'uapkg.exe' : 'uapkg';
    const entries: { path: string; type: string }[] = [];
    await tar.t({
      file: path.join(scratch, archive),
      onReadEntry: (entry) => entries.push({ path: entry.path, type: entry.type }),
    });
    if (entries.length !== 1 || entries[0]!.path !== executable || entries[0]!.type !== 'File')
      throw new Error('Launcher archive must contain only its executable.');
    mkdirSync(output, { recursive: true });
    await tar.x({ file: path.join(scratch, archive), cwd: output, strict: true });
    chmodSync(path.join(output, executable), 0o755);
    if (runChecked(path.join(path.resolve(output), executable), ['launcher', '--version'], output).trim() !== version)
      throw new Error('Downloaded launcher version differs.');
    if (runChecked(path.join(path.resolve(output), executable), ['launcher', '--platform'], output).trim() !== platform)
      throw new Error('Downloaded launcher platform differs from the qualification runtime.');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    await fetchSmokeLauncher(process.argv[2] ?? '', path.resolve(process.argv[3] ?? 'dist/smoke-launcher'));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
