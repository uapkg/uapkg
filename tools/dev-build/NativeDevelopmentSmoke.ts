import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBuildMetadata, renderBuildMetadataModule } from '../../packages/uapkg/build/CliBuild.ts';
import { NativeDevInstallation } from './NativeDevInstallation.ts';
import type { DevelopmentPath } from './DevelopmentPath.ts';

/** Exercise the real development launcher and built engine with a disposable home. */
export function smokeNativeDevelopmentInstallation(launcherPath: string): void {
  const repository = path.resolve(import.meta.dirname, '../..');
  const sourcePackage = path.join(repository, 'packages', 'uapkg');
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(sourcePackage, 'package.json'), 'utf8')) as {
    version: string;
    dependencies: Record<string, string>;
  };
  const metadata = createBuildMetadata('development', sourceManifest.version);
  // Hosted Windows runners can expose TEMP through an 8.3 alias while CMD and
  // the native launcher report its long path. Give the fixture one identity.
  const temporaryRoot = fs.realpathSync.native(os.tmpdir());
  const scratch = fs.mkdtempSync(path.join(temporaryRoot, 'uapkg-native-development-'));
  assert.equal(path.dirname(scratch), temporaryRoot);
  try {
    const workspace = path.join(scratch, 'checkout with spaces');
    const enginePackage = path.join(workspace, 'packages', 'uapkg');
    fs.mkdirSync(enginePackage, { recursive: true });
    fs.copyFileSync(path.join(sourcePackage, 'package.json'), path.join(enginePackage, 'package.json'));
    fs.cpSync(path.join(sourcePackage, 'dist'), path.join(enginePackage, 'dist'), { recursive: true });
    // Resolve each dependency before linking it. Linking node_modules wholesale
    // can reinterpret pnpm's relative workspace links against this temporary
    // checkout on Windows, especially when it is on another drive.
    // Dependencies remain read-only; only the copied engine is restamped.
    for (const dependency of Object.keys(sourceManifest.dependencies)) {
      const destination = path.join(enginePackage, 'node_modules', dependency);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(
        fs.realpathSync(path.join(sourcePackage, 'node_modules', dependency)),
        destination,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    fs.writeFileSync(
      path.join(enginePackage, 'dist', 'build', 'BuildMetadata.js'),
      renderBuildMetadataModule(metadata),
    );

    const home = path.join(scratch, 'home');
    const productionConfig = path.join(home, '.uapkg', 'config.json');
    fs.mkdirSync(path.dirname(productionConfig), { recursive: true });
    const productionBytes = '{"term":{"verbose":false}}\n';
    fs.writeFileSync(productionConfig, productionBytes);
    const project = path.join(scratch, 'game');
    const cwd = path.join(project, 'Plugins', 'Example', 'Source');
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(
      path.join(project, 'uapkg.json'),
      JSON.stringify({ name: 'smoke-project', version: '1.0.0', kind: 'project', uapkgVersion: '999.0.0' }),
    );
    // This smoke runs in CI too: exercise installation/PATH ownership without
    // changing the real user's registry or shell profiles.
    let pathPresent = false;
    const pathManager: DevelopmentPath = {
      capture: (directory) => ({
        schemaVersion: 1,
        platform: process.platform === 'win32' ? 'win32' : 'posix',
        directory,
        preexisting: pathPresent,
        processPreexisting: false,
        ...(process.platform === 'win32' ? {} : { profilePath: path.join(home, '.profile') }),
      }),
      add: () => {
        const changed = !pathPresent;
        pathPresent = true;
        return changed;
      },
      restore: (_directory, snapshot) => {
        if (snapshot.preexisting) return false;
        const changed = pathPresent;
        pathPresent = false;
        return changed;
      },
    };
    const installation = new NativeDevInstallation(workspace, { homeDirectory: home, pathManager });
    assert.equal(installation.binDirectory, path.join(home, '.uapkg-development', 'bin'));
    installation.link(path.resolve(launcherPath));
    assert.equal(pathPresent, true);
    assert.deepEqual(fs.readdirSync(path.join(home, '.uapkg')), ['config.json']);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NODE_OPTIONS: '',
      NODE_PATH: '',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    };
    // Windows environment names are case-insensitive. Keep a single PATH key
    // so Node cannot select an inherited differently-cased duplicate.
    for (const name of Object.keys(environment)) {
      if (name.toLowerCase() === 'path') delete environment[name];
    }
    environment.PATH = `${installation.binDirectory}${path.delimiter}${process.env.PATH ?? ''}`;
    const run = (executable: string, args: string[]) => {
      const result = spawnSync(executable, args, {
        cwd,
        env: environment,
        encoding: 'utf8',
        timeout: 20_000,
        windowsHide: true,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      return result;
    };
    const invoke = (args: string[]) => run(installation.executablePath, args);
    const verifyWindowsShells = (displayVersion: string) => {
      if (process.platform !== 'win32') return;
      for (const [shell, args] of [
        [
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '(Get-Command uapkg -ErrorAction Stop).Source; uapkg --offline --version; exit $LASTEXITCODE',
          ],
        ],
        ['cmd.exe', ['/d', '/s', '/c', 'where.exe uapkg && uapkg --offline --version']],
      ] as const) {
        const result = run(shell, [...args]);
        const lines = result.stdout.trim().split(/\r?\n/);
        assert.ok(lines[0], `${shell} did not resolve the launcher`);
        assert.equal(
          fs.realpathSync.native(lines[0]).toLowerCase(),
          fs.realpathSync.native(installation.executablePath).toLowerCase(),
          `${shell} resolution`,
        );
        assert.equal(lines.at(-1), displayVersion, `${shell} version`);
        assert.match(result.stderr, /DEVELOPMENT BUILD/, `${shell} banner`);
      }
    };
    const version = invoke(['--offline', '--version']);
    assert.equal(version.stdout.trim(), metadata.displayVersion);
    assert.match(version.stderr, /DEVELOPMENT BUILD/);
    verifyWindowsShells(metadata.displayVersion);
    assert.equal(invoke(['version', 'current']).stdout.trim(), sourceManifest.version);
    invoke(['config', 'set', 'launcher.cliSource', 'npm', '--global']);
    assert.equal(JSON.parse(invoke(['config', 'get', 'launcher.cliSource', '--global']).stdout), 'npm');
    invoke(['config', 'set', 'term.verbose', 'true', '--global']);
    const developmentConfig = JSON.parse(
      fs.readFileSync(path.join(home, '.uapkg-development', 'config.json'), 'utf8'),
    ) as { launcher: { cliSource: string }; term: { verbose: boolean } };
    assert.equal(developmentConfig.launcher.cliSource, 'npm');
    assert.equal(developmentConfig.term.verbose, true);
    const diagnostic = invoke(['install', '--debug-info', '--offline']);
    for (const expected of [
      'UAPKG debug information',
      'Profile: development',
      'Launcher context: available',
      `Launcher path: ${installation.executablePath}`,
      `CLI path: ${path.join(enginePackage, 'dist', 'cli.js')}`,
      'Installation owner: development',
      'CLI source: npm',
      `Global CLI version: ${sourceManifest.version}`,
      'Project CLI pin: 999.0.0',
      `Selected CLI version: ${sourceManifest.version}`,
      'Selection reason: development',
      'Engine kind: development',
      'Offline: yes',
      'Environment collection: available',
    ]) {
      assert.ok(diagnostic.stdout.includes(expected), `Missing diagnostic field: ${expected}`);
    }
    assert.equal(fs.existsSync(path.join(home, '.uapkg-development', 'launcher.json')), false);
    assert.equal(fs.readFileSync(productionConfig, 'utf8'), productionBytes);
    assert.equal(fs.existsSync(path.join(home, '.uapkg-development', 'engines')), false);

    // Simulate a subsequent engine build and relink using only the copied
    // checkout. Each invocation must observe the new build and receipt.
    const rebuiltVersion = '0.0.0-dev-smoke+rebuilt.1';
    const rebuiltMetadata = createBuildMetadata('development', rebuiltVersion);
    fs.writeFileSync(
      path.join(enginePackage, 'package.json'),
      JSON.stringify({ ...sourceManifest, version: rebuiltVersion }),
    );
    fs.writeFileSync(
      path.join(enginePackage, 'dist', 'build', 'BuildMetadata.js'),
      renderBuildMetadataModule(rebuiltMetadata),
    );
    installation.link(path.resolve(launcherPath));
    assert.equal(invoke(['--offline', '--version']).stdout.trim(), rebuiltMetadata.displayVersion);
    assert.equal(invoke(['version', 'current']).stdout.trim(), rebuiltVersion);
    verifyWindowsShells(rebuiltMetadata.displayVersion);
    installation.unlink();
    assert.equal(pathPresent, false);
    assert.equal(fs.existsSync(installation.executablePath), false);
    assert.equal(fs.readFileSync(productionConfig, 'utf8'), productionBytes);
    assert.deepEqual(fs.readdirSync(path.join(home, '.uapkg')), ['config.json']);
    console.log(
      'Native development smoke passed: local engine, project-pin bypass, version reporting, diagnostics, banner, profile isolation, relink, shell resolution, and unlink.',
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
