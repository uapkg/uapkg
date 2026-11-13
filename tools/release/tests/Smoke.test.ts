import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { renderInkSmoke } from '../Smoke.ts';

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
