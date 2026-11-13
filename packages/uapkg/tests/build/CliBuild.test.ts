import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INTERNAL_BUILD_MODE_ENV, INTERNAL_PROFILE_HOME_ENV } from '@uapkg/common';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  createBuildMetadata,
  DEVELOPMENT_BANNER_TEXT,
  parseBuildMode,
  renderCliLauncher,
  resolveCliBuildPaths,
  verifyBuiltCli,
  verifyProductionBuild,
  writeBuildArtifacts,
} from '../../build/CliBuild.ts';

const temporaryDirectories: string[] = [];

function createTemporaryPackage() {
  const packageRoot = mkdtempSync(path.join(os.tmpdir(), 'uapkg-cli-build-'));
  temporaryDirectories.push(packageRoot);
  writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@uapkg/cli-build-test',
      private: true,
      type: 'module',
      version: '2.3.4',
      dependencies: { '@uapkg/common': 'workspace:^' },
    }),
    'utf8',
  );
  const commonPackageRoot = path.join(packageRoot, 'node_modules', '@uapkg', 'common');
  const commonDist = path.join(commonPackageRoot, 'dist');
  mkdirSync(commonDist, { recursive: true });
  writeFileSync(
    path.join(commonPackageRoot, 'package.json'),
    JSON.stringify({ name: '@uapkg/common', private: true, type: 'module', exports: './dist/index.js' }),
    'utf8',
  );
  writeFileSync(
    path.join(commonDist, 'index.js'),
    `import os from 'node:os';
import path from 'node:path';

export const INTERNAL_BUILD_MODE_ENV = ${JSON.stringify(INTERNAL_BUILD_MODE_ENV)};
export const INTERNAL_PROFILE_HOME_ENV = ${JSON.stringify(INTERNAL_PROFILE_HOME_ENV)};
export function resolveUapkgProfileRoot(mode, homeDirectory = os.homedir()) {
  return path.join(homeDirectory, mode === 'development' ? '.uapkg-development' : '.uapkg');
}
`,
    'utf8',
  );

  const paths = resolveCliBuildPaths(packageRoot);
  writeBuildArtifacts(paths, createBuildMetadata('production', '2.3.4'));
  writeFileSync(
    path.join(paths.distDirectory, 'cli-bootstrap.js'),
    `import { UAPKG_BUILD_METADATA } from './build/BuildMetadata.js';
if (process.argv.includes('--version')) {
  process.stdout.write(\`\${UAPKG_BUILD_METADATA.displayVersion}\\n\`);
} else if (process.argv.includes('--help')) {
  process.stdout.write('HELP OUTPUT\\n');
} else if (process.argv.includes('--profile-home')) {
  process.stdout.write(\`\${process.env[${JSON.stringify(INTERNAL_PROFILE_HOME_ENV)}] ?? ''}\\n\`);
} else if (process.argv.includes('--build-mode')) {
  process.stdout.write(\`\${process.env[${JSON.stringify(INTERNAL_BUILD_MODE_ENV)}] ?? ''}\\n\`);
} else {
  process.stderr.write('COMMAND ERROR\\n');
  process.exitCode = 1;
}
`,
    'utf8',
  );
  return paths;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('CLI build mode', () => {
  it('defaults to production and accepts either explicit mode', () => {
    expect(parseBuildMode([])).toBe('production');
    expect(parseBuildMode(['--production'])).toBe('production');
    expect(parseBuildMode(['--development'])).toBe('development');
    expect(parseBuildMode(['--', '--development'])).toBe('development');
  });

  it('rejects conflicting, duplicate, and unknown flags', () => {
    expect(() => parseBuildMode(['--development', '--production'])).toThrow(
      '--development and --production cannot be used together',
    );
    expect(() => parseBuildMode(['--development', '--development'])).toThrow(
      'Each build mode flag may be provided only once',
    );
    expect(() => parseBuildMode(['--staging'])).toThrow('Unknown build option(s): --staging');
  });

  it('uses the package version verbatim in production and marks development versions', () => {
    expect(createBuildMetadata('production', '1.2.3')).toEqual({
      mode: 'production',
      packageVersion: '1.2.3',
      displayVersion: '1.2.3',
    });
    expect(createBuildMetadata('development', '1.2.3')).toEqual({
      mode: 'development',
      packageVersion: '1.2.3',
      displayVersion: '1.2.3-development-mode',
    });
  });

  it('renders the requested blue-background and white-text development banner', () => {
    const launcher = renderCliLauncher();

    expect(launcher).toContain('\\u001B[44m\\u001B[37mDEVELOPMENT BUILD\\u001B[0m');
    expect(launcher).toContain('process.stderr.write');
  });

  it('selects the stamped global profile before importing the CLI', () => {
    const launcher = renderCliLauncher();

    expect(launcher.indexOf('process.env[INTERNAL_BUILD_MODE_ENV]')).toBeLessThan(
      launcher.indexOf("await import('./cli-bootstrap.js')"),
    );
    expect(launcher.indexOf('process.env[INTERNAL_PROFILE_HOME_ENV]')).toBeLessThan(
      launcher.indexOf("await import('./cli-bootstrap.js')"),
    );
    expect(launcher).toContain('process.env[INTERNAL_BUILD_MODE_ENV] = UAPKG_BUILD_METADATA.mode');
    expect(launcher).toContain(
      'process.env[INTERNAL_PROFILE_HOME_ENV] = resolveUapkgProfileRoot(UAPKG_BUILD_METADATA.mode)',
    );
  });
});

describe('stamped CLI artifacts', () => {
  it('switches between development and production without cleaning dist', async () => {
    const paths = createTemporaryPackage();
    for (const staleName of ['cli.d.ts', 'cli.d.ts.map', 'cli.js.map']) {
      writeFileSync(path.join(paths.distDirectory, staleName), 'stale', 'utf8');
    }

    const development = createBuildMetadata('development', '2.3.4');
    writeBuildArtifacts(paths, development);
    await expect(verifyBuiltCli(paths, development)).resolves.toBeUndefined();
    expect(readFileSync(paths.metadataPath, 'utf8')).toContain('"mode": "development"');
    expect(readFileSync(paths.launcherPath, 'utf8')).toContain("await import('./cli-bootstrap.js')");

    const production = createBuildMetadata('production', '2.3.4');
    writeBuildArtifacts(paths, production);
    await expect(verifyBuiltCli(paths, production)).resolves.toBeUndefined();
    await expect(verifyProductionBuild(paths)).resolves.toBeUndefined();
    expect(readFileSync(paths.metadataPath, 'utf8')).toContain('"mode": "production"');
    for (const staleName of ['cli.d.ts', 'cli.d.ts.map', 'cli.js.map']) {
      expect(() => readFileSync(path.join(paths.distDirectory, staleName))).toThrow();
    }
  });

  it('writes the development banner before command errors while preserving help stdout', () => {
    const paths = createTemporaryPackage();
    writeBuildArtifacts(paths, createBuildMetadata('development', '2.3.4'));

    const errorResult = spawnSync(process.execPath, [paths.launcherPath, 'invalid'], {
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    expect(errorResult.status).toBe(1);
    expect(errorResult.stdout).toBe('');
    expect(errorResult.stderr).toBe(`${DEVELOPMENT_BANNER_TEXT}\nCOMMAND ERROR\n`);

    const helpResult = spawnSync(process.execPath, [paths.launcherPath, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    expect(helpResult.status).toBe(0);
    expect(helpResult.stdout).toBe('HELP OUTPUT\n');
    expect(helpResult.stderr).toBe(`${DEVELOPMENT_BANNER_TEXT}\n`);
  });

  it.each([
    ['production', '.uapkg'],
    ['development', '.uapkg-development'],
  ] as const)('overrides inherited profile state for a %s build', (mode, profileDirectory) => {
    const paths = createTemporaryPackage();
    writeBuildArtifacts(paths, createBuildMetadata(mode, '2.3.4'));

    const result = spawnSync(process.execPath, [paths.launcherPath, '--profile-home'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        [INTERNAL_PROFILE_HOME_ENV]: path.join(os.homedir(), 'wrong-profile'),
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${path.join(os.homedir(), profileDirectory)}\n`);
    expect(result.stderr).toBe(mode === 'development' ? `${DEVELOPMENT_BANNER_TEXT}\n` : '');
  });

  it.each(['production', 'development'] as const)('overrides inherited build-mode state for a %s build', (mode) => {
    const paths = createTemporaryPackage();
    writeBuildArtifacts(paths, createBuildMetadata(mode, '2.3.4'));

    const result = spawnSync(process.execPath, [paths.launcherPath, '--build-mode'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        [INTERNAL_BUILD_MODE_ENV]: mode === 'development' ? 'production' : 'development',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${mode}\n`);
    expect(result.stderr).toBe(mode === 'development' ? `${DEVELOPMENT_BANNER_TEXT}\n` : '');
  });

  it('rejects a development artifact when production verification is required', async () => {
    const paths = createTemporaryPackage();
    writeBuildArtifacts(paths, createBuildMetadata('development', '2.3.4'));

    await expect(verifyProductionBuild(paths)).rejects.toThrow('Expected mode "production", received "development"');
  });

  it('rejects a launcher without the portable Node shebang', async () => {
    const paths = createTemporaryPackage();
    writeFileSync(paths.launcherPath, readFileSync(paths.launcherPath, 'utf8').replace('#!/usr/bin/env node\n', ''));

    await expect(verifyBuiltCli(paths, createBuildMetadata('production', '2.3.4'))).rejects.toThrow(
      'must begin with #!/usr/bin/env node',
    );
  });

  it.skipIf(process.platform === 'win32')('rejects a non-executable POSIX launcher', async () => {
    const paths = createTemporaryPackage();
    chmodSync(paths.launcherPath, 0o644);

    await expect(verifyBuiltCli(paths, createBuildMetadata('production', '2.3.4'))).rejects.toThrow(
      'must have mode 0755',
    );
  });
});

describe('build wiring', () => {
  it('uses managed Node directly inside Vite Task because local Vite+ 0.2.9 lacks vp node', () => {
    const packageRoot = resolveCliBuildPaths().packageRoot;
    const packageJson = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.build).toBe('node build/runCliBuild.ts');
    expect(packageJson.scripts?.build).not.toContain('vp node');
    expect(packageJson.scripts?.['verify:production-build']).toBe('vp exec node build/verifyProductionBuild.ts');
    expect(packageJson.scripts?.prepack).toBe(
      'vp run -w --cache cli:build -- --production && vp exec node build/prepareEnginePackage.ts',
    );
  });
});
