import path from 'node:path';
import { ProcessRunner } from '../dev-build/ProcessRunner.ts';
import { syncLauncherVersion } from '../launcher/LauncherVersion.ts';

export function versionPackages(workspaceRoot: string, args: string[] = []): void {
  const changesetArgs = args[0] === '--' ? args.slice(1) : args;
  if (changesetArgs.some((arg) => arg === '--snapshot' || arg.startsWith('--snapshot='))) {
    throw new Error('Snapshot versions are not supported. Use stable versions or numbered alpha/beta prereleases.');
  }
  new ProcessRunner().run('vp', ['exec', 'changeset', 'version', ...changesetArgs], workspaceRoot);
  // A retry may have no remaining changesets after an earlier Cargo sync failed.
  syncLauncherVersion(workspaceRoot);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    versionPackages(path.resolve(import.meta.dirname, '../..'), process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
