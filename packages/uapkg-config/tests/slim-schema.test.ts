import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INTERNAL_PROFILE_HOME_ENV } from '@uapkg/common';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createConfig } from '../src/index.ts';
import { createSlimConfigSchema } from '../src/slim-schema.ts';
import { getDefaultConfig } from '../src/schema/configSchema.ts';

interface Fixture {
  name: string;
  cwd: string;
  manifests: string[];
  files: Record<string, string>;
  expected: { launcher: Record<string, unknown> };
  origins: Record<string, string>;
  ignored: string[];
}

const artifactDirectory = new URL('../../../launcher/crates/slim-config/', import.meta.url);
const fixtures = JSON.parse(
  fs.readFileSync(new URL('fixtures/resolution.json', artifactDirectory), 'utf8'),
) as Fixture[];
const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('native schema contract', () => {
  it('exports only launcher config and derives embedded defaults from the full handler', () => {
    const schema = createSlimConfigSchema();
    expect(schema.default).toEqual({ launcher: getDefaultConfig().launcher });
    expect(Object.keys(schema.properties as object)).toEqual(['launcher']);
    expect(schema).toHaveProperty(
      'properties.launcher.properties.autoUpdate.properties.minimumReleaseAge.default',
      '3d',
    );
    expect(
      JSON.parse(fs.readFileSync(new URL('generated/slim-config.schema.json', artifactDirectory), 'utf8')),
    ).toEqual(schema);
  });

  it.each(fixtures)('$name', (fixture) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uapkg-slim-contract-'));
    roots.push(root);
    const cwd = path.join(root, fixture.cwd);
    fs.mkdirSync(cwd, { recursive: true });
    for (const manifest of fixture.manifests) {
      fs.mkdirSync(path.dirname(path.join(root, manifest)), { recursive: true });
      // Manifest contents are deliberately irrelevant to config directory walking.
      fs.writeFileSync(path.join(root, manifest), 'not parsed by config');
    }
    for (const [relative, content] of Object.entries(fixture.files)) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), content);
    }
    const before = snapshot(root);
    vi.stubEnv(INTERNAL_PROFILE_HOME_ENV, path.join(root, 'profile'));
    const config = createConfig({ cwd });
    expect(config.get('launcher')).toEqual(fixture.expected.launcher);
    for (const [property, source] of Object.entries(fixture.origins)) {
      expect(config.getWithOrigin(property)).toMatchObject({ value: config.get(property), source });
    }
    const ignored = config.getDiagnostics().flatMap((diagnostic) => {
      if (diagnostic.code === 'CONFIG_INVALID_VALUE' && diagnostic.data.ignored) return [diagnostic.data.path];
      if (diagnostic.code === 'CONFIG_INVALID_JSON') return ['$'];
      if (diagnostic.code === 'CONFIG_TYPE_MISMATCH' && diagnostic.data.path === '$') return ['$'];
      return [];
    });
    expect(ignored.sort()).toEqual([...fixture.ignored].sort());
    if (fixture.ignored.some((property) => property === '$' || property === 'launcher')) {
      const trace = config.trace('launcher.defaultCliVersion');
      expect(trace.some((entry) => entry.status === 'ignored' && Boolean(entry.reason))).toBe(true);
    }
    expect(snapshot(root)).toEqual(before);
  });

  it('traces ignored overrides while reporting the winning accepted origin', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uapkg-slim-trace-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'profile'));
    fs.mkdirSync(path.join(root, '.uapkg'));
    fs.writeFileSync(path.join(root, 'profile/config.json'), '{"launcher":{"defaultCliVersion":"1.2.3"}}');
    fs.writeFileSync(path.join(root, '.uapkg/config.json'), '{"launcher":{"defaultCliVersion":"^2.0.0"}}');
    vi.stubEnv(INTERNAL_PROFILE_HOME_ENV, path.join(root, 'profile'));
    const config = createConfig({ cwd: root });
    expect(config.getWithOrigin('launcher.defaultCliVersion')).toMatchObject({ source: 'global', value: '1.2.3' });
    expect(config.trace('launcher.defaultCliVersion')).toMatchObject([
      { source: 'default', value: 'latest', status: 'accepted' },
      { source: 'global', value: '1.2.3', status: 'accepted' },
      { source: 'local', value: '^2.0.0', status: 'ignored', reason: expect.stringContaining('retaining "1.2.3"') },
    ]);
    expect(config.getDiagnostics()[0]?.message).toContain('Ignored "launcher.defaultCliVersion" in local config');
  });

  it('ignores unreadable files and traces the failure without creating other paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uapkg-slim-unreadable-'));
    roots.push(root);
    // A directory at the config path is an unreadable file on every target OS.
    fs.mkdirSync(path.join(root, '.uapkg/config.json'), { recursive: true });
    vi.stubEnv(INTERNAL_PROFILE_HOME_ENV, path.join(root, 'missing-profile'));
    const before = snapshot(root);
    const config = createConfig({ cwd: root });
    expect(config.get('launcher')).toEqual(getDefaultConfig().launcher);
    expect(config.getDiagnostics()).toMatchObject([{ code: 'IO_ERROR' }]);
    expect(config.trace('launcher.defaultCliVersion').at(-1)).toMatchObject({ source: 'local', status: 'ignored' });
    expect(snapshot(root)).toEqual(before);
  });
});

function snapshot(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true })
    .map(String)
    .sort()
    .map((relative) => {
      const file = path.join(root, relative);
      return fs.statSync(file).isFile() ? `${relative}:${fs.readFileSync(file, 'utf8')}` : relative;
    });
}
