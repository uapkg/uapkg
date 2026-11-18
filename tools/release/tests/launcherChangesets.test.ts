import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { ProcessRunner } from '../../dev-build/ProcessRunner.ts';
import { syncLauncherVersion } from '../../launcher/LauncherVersion.ts';
import { versionPackages } from '../versionPackages.ts';

vi.mock('../../launcher/LauncherVersion.ts', () => ({ syncLauncherVersion: vi.fn() }));

const require = createRequire(import.meta.url);
const changesetCli = path.resolve(path.dirname(require.resolve('@changesets/cli')), '../bin.js');
const temporaryRoot = realpathSync(os.tmpdir());
const fixtures: string[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

beforeEach(() => {
  vi.spyOn(ProcessRunner.prototype, 'run').mockImplementation((command, args, cwd) => {
    expect(command).toBe('vp');
    expect(args.slice(0, 3)).toEqual(['exec', 'changeset', 'version']);
    const result = spawnSync(process.execPath, [changesetCli, ...args.slice(2)], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Changesets failed: ${result.stdout}\n${result.stderr}`);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(syncLauncherVersion).mockReset();
  for (const root of fixtures.splice(0)) {
    if (path.dirname(root) !== temporaryRoot || !path.basename(root).startsWith('uapkg-launcher-changesets-')) {
      throw new Error('Refusing to remove a directory outside the Changesets test fixtures.');
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(releases: Record<string, 'patch' | 'minor'>): string {
  const root = mkdtempSync(path.join(temporaryRoot, 'uapkg-launcher-changesets-'));
  fixtures.push(root);
  writeJson(path.join(root, 'package.json'), { name: 'launcher-changesets-fixture', private: true });
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n  - launcher\n');
  const config = JSON.parse(readFileSync(path.join(repositoryRoot, '.changeset/config.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  writeJson(path.join(root, '.changeset/config.json'), {
    ...config,
    // Use Changesets' local changelog renderer so tests never require GitHub credentials.
    changelog: [require.resolve('@changesets/cli/changelog'), {}],
  });
  writeJson(path.join(root, 'launcher/package.json'), { name: 'uapkg-launcher', version: '0.3.3', private: true });
  writeJson(path.join(root, 'packages/cli/package.json'), { name: '@uapkg/cli', version: '1.7.0' });
  writeJson(path.join(root, 'packages/config/package.json'), { name: '@uapkg/config', version: '1.7.0' });
  const frontmatter = Object.entries(releases)
    .map(([name, bump]) => `${JSON.stringify(name)}: ${bump}`)
    .join('\n');
  writeFileSync(
    path.join(root, '.changeset/fixture-release.md'),
    `---\n${frontmatter}\n---\n\nUpdate configuration.\n`,
  );
  return root;
}

function version(root: string, directory: string): string {
  return (JSON.parse(readFileSync(path.join(root, directory, 'package.json'), 'utf8')) as { version: string }).version;
}

describe('launcher Changesets integration', () => {
  it('versions the private launcher target and writes its changelog independently of the CLI family', () => {
    const root = fixture({ 'uapkg-launcher': 'patch' });

    versionPackages(root);

    expect(version(root, 'launcher')).toBe('0.3.4');
    expect(version(root, 'packages/cli')).toBe('1.7.0');
    expect(version(root, 'packages/config')).toBe('1.7.0');
    const changelog = readFileSync(path.join(root, 'launcher/CHANGELOG.md'), 'utf8');
    expect(changelog).toContain('0.3.4');
    expect(changelog).toContain('Update configuration.');
    expect(syncLauncherVersion).toHaveBeenCalledExactlyOnceWith(root);
    expect(existsSync(path.join(root, '.changeset/fixture-release.md'))).toBe(false);
  });

  it('bumps the fixed CLI family without changing the launcher version', () => {
    const root = fixture({ '@uapkg/config': 'patch' });

    versionPackages(root);

    expect(version(root, 'packages/cli')).toBe('1.7.1');
    expect(version(root, 'packages/config')).toBe('1.7.1');
    expect(version(root, 'launcher')).toBe('0.3.3');
    expect(existsSync(path.join(root, 'launcher/CHANGELOG.md'))).toBe(false);
    expect(syncLauncherVersion).toHaveBeenCalledExactlyOnceWith(root);
  });

  it('applies different bump levels to launcher and CLI changes in the same version operation', () => {
    const root = fixture({ 'uapkg-launcher': 'patch', '@uapkg/config': 'minor' });

    versionPackages(root);

    expect(version(root, 'launcher')).toBe('0.3.4');
    expect(version(root, 'packages/cli')).toBe('1.8.0');
    expect(version(root, 'packages/config')).toBe('1.8.0');
    expect(readFileSync(path.join(root, 'launcher/CHANGELOG.md'), 'utf8')).toContain('0.3.4');
    expect(readFileSync(path.join(root, 'packages/cli/CHANGELOG.md'), 'utf8')).toContain('1.8.0');
    expect(syncLauncherVersion).toHaveBeenCalledExactlyOnceWith(root);
  });
});
