import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { assertPackagedDiagnostics, renderInkSmoke } from '../Smoke.ts';

describe('packaged diagnostics with and without system utilities', () => {
  const expected = { cliPath: '/engine/dist/cli.js', secret: 'private-test-value', utilitiesAvailable: true };
  const output = (state: string) => ({
    stdout: `UAPKG debug information\nSystem:\nEnvironment collection: ${state}\nCLI path: ${expected.cliPath}\n`,
    stderr: '',
  });
  it('requires successful collection with normal PATH and accepts graceful unavailability only with empty PATH', () => {
    expect(() => assertPackagedDiagnostics(output('available'), expected)).not.toThrow();
    expect(() => assertPackagedDiagnostics(output('unavailable'), expected)).toThrow('collect environment');
    expect(() =>
      assertPackagedDiagnostics(output('unavailable'), { ...expected, utilitiesAvailable: false }),
    ).not.toThrow();
    expect(() =>
      assertPackagedDiagnostics(output('available'), { ...expected, utilitiesAvailable: false }),
    ).not.toThrow();
  });
  it('still rejects missing output, wrong executable identity, and private environment leakage with empty PATH', () => {
    const minimal = { ...expected, utilitiesAvailable: false };
    expect(() => assertPackagedDiagnostics(output('unknown'), minimal)).toThrow('collect environment');
    expect(() =>
      assertPackagedDiagnostics({ ...output('unavailable'), stdout: 'Environment collection: unavailable\n' }, minimal),
    ).toThrow('collect environment');
    expect(() => assertPackagedDiagnostics(output('unavailable'), { ...minimal, cliPath: '/wrong/cli.js' })).toThrow(
      'executing CLI',
    );
    expect(() => assertPackagedDiagnostics({ ...output('unavailable'), stderr: expected.secret }, minimal)).toThrow(
      'private environment',
    );
  });
});

describe('packaged interactive runtime probe', () => {
  it.each(['true', 'false'])('observes both Ink frames and raw-mode cleanup with CI=%s', (ci) => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'uapkg-ink-probe-'));
    try {
      const probe = path.join(scratch, 'probe.mjs');
      const manifest = path.resolve(import.meta.dirname, '../../../packages/uapkg/package.json');
      writeFileSync(
        probe,
        `import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require = createRequire(${JSON.stringify(manifest)});
${renderInkSmoke()}`,
      );
      const result = spawnSync(process.execPath, [probe], {
        cwd: scratch,
        env: { ...process.env, CI: ci, CONTINUOUS_INTEGRATION: ci },
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
