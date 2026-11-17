import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Build only the independent PTY harness, never the launcher being qualified. */
export function smokePackagedTerminal(engineRoot: string, launcher: string): void {
  if (!existsSync(path.resolve(launcher))) throw new Error('The verified release launcher is missing.');
  const harness = process.env.UAPKG_TERMINAL_SMOKE_BINARY;
  if (harness && (!path.isAbsolute(harness) || !existsSync(harness)))
    throw new Error('The precompiled terminal qualification harness must be an existing absolute path.');
  const result = spawnSync(
    harness ?? 'cargo',
    harness ? ['--test-threads=1'] : ['test', '--locked', '--', '--test-threads=1'],
    {
      cwd: path.resolve(import.meta.dirname, 'terminal-smoke'),
      env: { ...process.env, UAPKG_TEST_ENGINE: path.resolve(engineRoot), UAPKG_TEST_LAUNCHER: path.resolve(launcher) },
      stdio: 'inherit',
      timeout: 300_000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(`Packaged terminal qualification failed: ${result.error?.message ?? `exit ${result.status}`}`);
}
