import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { assertPackagedDiagnostics, renderHeadlessCredentialSmoke, renderInkSmoke } from '../Smoke.ts';

describe('headless credential-store qualification', () => {
  function probe(requireUnavailable: boolean, failure = '') {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'uapkg-headless-probe-'));
    try {
      const file = path.join(scratch, 'probe.mjs');
      writeFileSync(
        file,
        `import assert from 'node:assert/strict';
let roundTrips = 0;
const failure = ${JSON.stringify(failure)};
const api = { CredentialStore: class {
  async assertAvailable() {
    roundTrips += 1;
    const unavailable = 'Secure operating-system credential storage is unavailable. UAPKG will not save login secrets in plaintext.';
    if (failure === 'unavailable') throw new Error(unavailable);
    if (failure === 'string') throw unavailable;
    if (failure === 'native') throw new Error('Native module failed to load');
  }
}};
${renderHeadlessCredentialSmoke()}
assert.equal(roundTrips, 1);
`,
      );
      const result = spawnSync(process.execPath, [file], {
        env: { ...process.env, UAPKG_RELEASE_SMOKE_REQUIRE_UNAVAILABLE: requireUnavailable ? '1' : '' },
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      return result;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it('accepts verified secure storage or the exact unavailable result on general headless hosts', () => {
    for (const failure of ['', 'unavailable']) {
      const result = probe(false, failure);
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it('requires unavailable storage in explicitly isolated environments', () => {
    const unavailable = probe(true, 'unavailable');
    expect(unavailable.status, unavailable.stderr).toBe(0);
    const available = probe(true);
    expect(available.status).not.toBe(0);
    expect(available.stderr).toContain('must exercise unavailable secure storage');
  });

  it.each([false, true])('rejects unrelated errors and non-Error failures with strict isolation=%s', (strict) => {
    for (const failure of ['native', 'string']) {
      const result = probe(strict, failure);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('must either pass a secure round-trip');
    }
  });
});

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
