import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

const entry = pathToFileURL(path.resolve(import.meta.dirname, '../../src/cli/LauncherNotices.ts')).href;
function invoke(raw: string, tail: string) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { registerLauncherNoticeFooter } from ${JSON.stringify(entry)}; registerLauncherNoticeFooter(); ${tail}`,
    ],
    {
      env: { ...process.env, UAPKG_LAUNCHER_NOTICES: raw },
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    },
  );
}
const versionNotice = 'A new UAPKG launcher version is available. 0.3.2 -> 0.3.3';
const updateNotice = 'Run `uapkg launcher-update` to update.';
const notice = JSON.stringify({ schemaVersion: 1, messages: [versionNotice, updateNotice, versionNotice] });
const footer = `\nuapkg: ${versionNotice}\nuapkg: ${updateNotice}\n`;
describe('launcher notice footer', () => {
  it('writes once to stderr, consumes inherited context and preserves stdout and status', () => {
    const result = invoke(
      notice,
      `if (process.env.UAPKG_LAUNCHER_NOTICES) throw new Error('context leaked'); process.stdout.write('{"result":true}'); registerLauncherNoticeFooter(); process.exitCode = 7;`,
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(7);
    expect(result.stdout).toBe('{"result":true}');
    expect(result.stderr).toBe(footer);
  });
  it('prints below errors reported during command completion', () => {
    const result = invoke(
      notice,
      `Promise.reject(new Error('command failed')).catch((error) => { console.error(error.message); process.exitCode = 1; });`,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`command failed\n${footer}`);
  });
  it('also handles synchronous parser exits without changing their code', () => {
    const result = invoke(notice, "console.error('invalid arguments'); process.exit(12);");
    expect(result.status).toBe(12);
    expect(result.stderr).toBe(`invalid arguments\n${footer}`);
  });
  it.each([
    'bad JSON',
    JSON.stringify({ schemaVersion: 2, messages: ['wrong schema'] }),
    JSON.stringify({ schemaVersion: 1, messages: ['\x1b[31mcontrol'] }),
    'x'.repeat(16_385),
  ])('ignores malformed or unbounded inherited context', (raw) => {
    const result = invoke(raw, "process.stdout.write('ok');");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ok');
    expect(result.stderr).toBe('');
  });
});
