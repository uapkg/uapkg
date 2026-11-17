import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { smokePackagedTerminal } from '../PackagedTerminalSmoke.ts';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn(() => ({ status: 0 })) }));
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('packaged terminal harness selection', () => {
  it('runs the precompiled harness without requiring cargo in the clean runtime environment', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'uapkg-terminal-harness-'));
    directories.push(root);
    const launcher = path.join(root, 'uapkg');
    const harness = path.join(root, 'terminal-tests');
    writeFileSync(launcher, 'launcher');
    writeFileSync(harness, 'test harness');
    vi.stubEnv('UAPKG_TERMINAL_SMOKE_BINARY', harness);
    smokePackagedTerminal(root, launcher);
    expect(spawnSync).toHaveBeenCalledWith(
      harness,
      ['--test-threads=1'],
      expect.objectContaining({
        env: expect.objectContaining({ UAPKG_TEST_ENGINE: root, UAPKG_TEST_LAUNCHER: launcher }),
      }),
    );
  });

  it('does not silently fall back to compiling a missing precompiled harness', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'uapkg-terminal-harness-'));
    directories.push(root);
    const launcher = path.join(root, 'uapkg');
    writeFileSync(launcher, 'launcher');
    vi.stubEnv('UAPKG_TERMINAL_SMOKE_BINARY', path.join(root, 'missing'));
    expect(() => smokePackagedTerminal(root, launcher)).toThrow('existing absolute path');
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
