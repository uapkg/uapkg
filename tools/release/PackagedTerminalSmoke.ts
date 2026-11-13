import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Qualify the shipped launcher and engine together using a real OS terminal. */
export function smokePackagedTerminal(engineRoot: string): void {
  const bundle = path.resolve(engineRoot, '../bundle');
  if (!existsSync(path.join(bundle, 'uapkg-install.json'))) {
    throw new Error(`The packaged terminal smoke requires the adjacent release bundle: ${bundle}`);
  }
  const result = spawnSync(
    'cargo',
    ['test', '--locked', '--test', 'packaged_terminal', '--', '--ignored', '--test-threads=1'],
    {
      cwd: path.resolve(import.meta.dirname, '../../launcher'),
      env: { ...process.env, UAPKG_TEST_BUNDLE: bundle },
      stdio: 'inherit',
      timeout: 180_000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Packaged terminal qualification failed: ${result.error?.message ?? `exit ${result.status}`}`);
  }
}
