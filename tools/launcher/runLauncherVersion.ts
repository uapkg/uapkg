import path from 'node:path';
import { checkLauncherVersion, syncLauncherVersion } from './LauncherVersion.ts';

try {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const workspaceRoot = path.resolve(import.meta.dirname, '../..');
  if (args.length !== 1 || !['sync', 'check'].includes(args[0])) {
    throw new Error('Usage: runLauncherVersion.ts <sync|check>');
  }
  if (args[0] === 'sync') syncLauncherVersion(workspaceRoot);
  else checkLauncherVersion(workspaceRoot);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
