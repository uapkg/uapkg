import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  CLI_ROOT,
  createRuntimePackageManifest,
  RUNTIME_TEMPLATE_ROOT,
  stampRuntimeLock,
  validateRuntimeDependencyPins,
} from '../../build/EnginePackage.ts';

describe('published CLI engine contract', () => {
  it('preserves the public module export while only Rust owns the command', () => {
    const source = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8'));
    const runtime = JSON.parse(readFileSync(path.join(RUNTIME_TEMPLATE_ROOT, 'package.json'), 'utf8'));
    const published = createRuntimePackageManifest(source, runtime);
    expect(source.bin).toBeUndefined();
    expect(published.bin).toBeUndefined();
    expect(published.exports).toEqual({ '.': { types: './dist/types/uapkg/index.d.ts', default: './dist/index.js' } });
    expect(Object.keys(published.dependencies as object).some((dependency) => dependency.startsWith('@uapkg/'))).toBe(
      false,
    );
    expect(published.engines).toEqual({ node: '>=26.0.0', npm: '>=11.12.1' });
  });

  it('stamps package identity without resolving or changing the frozen dependency graph', () => {
    const runtime = JSON.parse(readFileSync(path.join(RUNTIME_TEMPLATE_ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(path.join(RUNTIME_TEMPLATE_ROOT, 'package-lock.json'), 'utf8'));
    const stamped = stampRuntimeLock(lock, { name: '@uapkg/cli', version: '2.3.4' }, runtime);
    expect(stamped.name).toBe('@uapkg/cli');
    expect(stamped.packages[''].version).toBe('2.3.4');
    for (const [key, value] of Object.entries(lock.packages)) {
      if (key) expect(stamped.packages[key]).toEqual(value);
    }
    expect(stamped.packages['node_modules/@napi-rs/keyring-win32-arm64-msvc']).toBeDefined();
    expect(stamped.packages['node_modules/@napi-rs/keyring-linux-arm64-gnu']).toBeDefined();
    expect(stamped.packages['node_modules/@napi-rs/keyring-darwin-x64']).toBeDefined();
    expect(() =>
      stampRuntimeLock(lock, { name: '@uapkg/cli', version: '2.3.4' }, { ...runtime, dependencies: {} }),
    ).toThrow('runtime lock is stale');
  });

  it('rejects changed source dependency pins anywhere in the reachable workspace closure', () => {
    const packages: Parameters<typeof validateRuntimeDependencyPins>[0] = [
      {
        directory: 'uapkg',
        manifest: {
          name: '@uapkg/cli',
          version: '1.0.0',
          dependencies: { '@uapkg/core': 'workspace:^', esbuild: '0.28.0', semver: '7.7.4' },
        },
      },
      {
        directory: 'core',
        manifest: {
          name: '@uapkg/core',
          version: '1.0.0',
          dependencies: { ink: '6.8.0', semver: '7.7.1' },
          peerDependencies: { react: '>=19.0.0' },
        },
      },
      {
        directory: 'unrelated',
        manifest: { name: '@uapkg/unrelated', version: '1.0.0', dependencies: { ink: '5.0.0' } },
      },
    ];
    const runtime = { esbuild: '0.28.0', ink: '6.8.0', react: '19.2.4' };
    expect(() => validateRuntimeDependencyPins(packages, runtime)).not.toThrow();
    expect(() => validateRuntimeDependencyPins(packages, { ...runtime, esbuild: '0.27.0' })).toThrow(
      'differs from the release pin',
    );
    expect(() => validateRuntimeDependencyPins(packages, { ...runtime, ink: '6.7.0' })).toThrow('@uapkg/core -> ink');
    expect(() => validateRuntimeDependencyPins(packages, { ...runtime, react: '18.0.0' })).toThrow('does not satisfy');
    expect(() => validateRuntimeDependencyPins(packages, { esbuild: '0.28.0', react: '19.2.4' })).toThrow('(missing)');
  });
});
