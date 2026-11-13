import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { NativeDevInstallation } from '../NativeDevInstallation.ts';
import type { DevelopmentPath, DevelopmentPathSnapshot } from '../DevelopmentPath.ts';

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uapkg-native-link-'));
  directories.push(directory);
  const workspace = path.join(directory, 'workspace');
  const home = path.join(directory, 'home');
  const engine = path.join(workspace, 'packages', 'uapkg', 'dist', 'cli.js');
  fs.mkdirSync(path.dirname(engine), { recursive: true });
  fs.writeFileSync(engine, '// engine');
  fs.writeFileSync(path.join(workspace, 'packages', 'uapkg', 'package.json'), '{"version":"2.3.4"}');
  const built = path.join(directory, 'built-launcher');
  fs.writeFileSync(built, 'development binary');
  const pathState = { entries: [] as string[] };
  const pathManager = {
    capture: vi.fn((target): DevelopmentPathSnapshot => ({
      schemaVersion: 1,
      platform: process.platform === 'win32' ? 'win32' : 'posix',
      directory: target,
      preexisting: pathState.entries.includes(target),
      processPreexisting: false,
      ...(process.platform === 'win32' ? {} : { profilePath: path.join(home, '.profile') }),
    })),
    add: vi.fn((target) => {
      if (pathState.entries.includes(target)) return false;
      pathState.entries.unshift(target);
      return true;
    }),
    restore: vi.fn((target, snapshot) => {
      if (snapshot.preexisting || !pathState.entries.includes(target)) return false;
      pathState.entries = pathState.entries.filter((entry) => entry !== target);
      return true;
    }),
  } satisfies DevelopmentPath;
  const installation = new NativeDevInstallation(workspace, { homeDirectory: home, pathManager });
  return { directory, workspace, home, engine, built, installation, pathState, pathManager };
}

describe('native development installation', () => {
  it.each(['2.3.4', '2.3.4-beta.1', '2.3.4+build.7', '2.3.4-beta.1+build.007'])(
    'preserves the exact package version %s in the receipt',
    (version) => {
      const f = fixture();
      fs.writeFileSync(path.join(f.workspace, 'packages', 'uapkg', 'package.json'), JSON.stringify({ version }));
      f.installation.link(f.built);
      expect(f.installation.status().receipt?.defaultCliVersion).toBe(version);
    },
  );

  it.each(['v2.3.4', '=2.3.4', '^2.3.4', ' 2.3.4 ', '2.3', '2.3.4+'])(
    'rejects the non-exact package version %s before installation',
    (version) => {
      const f = fixture();
      fs.writeFileSync(path.join(f.workspace, 'packages', 'uapkg', 'package.json'), JSON.stringify({ version }));
      expect(() => f.installation.link(f.built)).toThrow('exact semantic version');
      expect(fs.existsSync(f.installation.binDirectory)).toBe(false);
    },
  );

  it('links only a native binary and local engine receipt, then unlinks without changing profiles', () => {
    const f = fixture();
    expect(f.installation.binDirectory).toBe(path.join(f.home, '.uapkg-development', 'bin'));
    for (const profile of ['.uapkg', '.uapkg-development']) {
      fs.mkdirSync(path.join(f.home, profile), { recursive: true });
      fs.writeFileSync(path.join(f.home, profile, 'config.json'), profile);
    }
    f.installation.link(f.built);
    expect(fs.readFileSync(f.installation.executablePath, 'utf8')).toBe('development binary');
    expect(f.installation.status()).toMatchObject({
      owned: true,
      receipt: {
        schemaVersion: 1,
        installMethod: 'development',
        defaultCliVersion: '2.3.4',
        development: { enginePath: f.engine, nodePath: process.execPath, checkoutPath: f.workspace },
      },
    });
    expect(fs.readdirSync(f.installation.binDirectory).sort()).toEqual(
      [path.basename(f.installation.executablePath), 'uapkg-install.json'].sort(),
    );
    f.installation.unlink();
    expect(fs.existsSync(f.installation.executablePath)).toBe(false);
    expect(fs.existsSync(f.installation.receiptPath)).toBe(false);
    for (const profile of ['.uapkg', '.uapkg-development'])
      expect(fs.readFileSync(path.join(f.home, profile, 'config.json'), 'utf8')).toBe(profile);
  });

  it('keeps an existing production executable and receipt unchanged while linking and unlinking development', () => {
    const f = fixture();
    const productionBin = path.join(f.home, '.uapkg', 'bin');
    const productionExecutable = path.join(productionBin, path.basename(f.installation.executablePath));
    const productionReceipt = path.join(productionBin, 'uapkg-install.json');
    fs.mkdirSync(productionBin, { recursive: true });
    fs.writeFileSync(productionExecutable, 'production binary');
    fs.writeFileSync(productionReceipt, '{"installMethod":"standalone"}');
    for (const action of [() => f.installation.link(f.built), () => f.installation.unlink()]) {
      action();
      expect(fs.readFileSync(productionExecutable, 'utf8')).toBe('production binary');
      expect(fs.readFileSync(productionReceipt, 'utf8')).toBe('{"installMethod":"standalone"}');
      expect(fs.readdirSync(productionBin).sort()).toEqual(
        [path.basename(productionExecutable), 'uapkg-install.json'].sort(),
      );
    }
  });

  it('preserves the original installation across repeated links and restores its exact bytes', () => {
    const f = fixture();
    fs.mkdirSync(f.installation.binDirectory, { recursive: true });
    fs.writeFileSync(f.installation.executablePath, 'original binary');
    fs.writeFileSync(f.installation.receiptPath, '{"installMethod":"standalone"}');
    expect(() => f.installation.link(f.built)).toThrow('already exists');
    f.installation.link(f.built, true);
    fs.writeFileSync(f.built, 'rebuilt binary');
    f.installation.link(f.built, true);
    expect(fs.readFileSync(f.installation.executablePath, 'utf8')).toBe('rebuilt binary');
    f.installation.unlink();
    expect(fs.readFileSync(f.installation.executablePath, 'utf8')).toBe('original binary');
    expect(fs.readFileSync(f.installation.receiptPath, 'utf8')).toBe('{"installMethod":"standalone"}');
  });

  it('refuses to unlink or overwrite a changed installation even with force', () => {
    const f = fixture();
    f.installation.link(f.built);
    fs.writeFileSync(f.installation.executablePath, 'different owner');
    expect(() => f.installation.unlink()).toThrow('no longer owns');
    expect(() => f.installation.link(f.built, true)).toThrow('changed since linking');
    expect(fs.readFileSync(f.installation.executablePath, 'utf8')).toBe('different owner');
    expect(fs.existsSync(f.installation.snapshotPath)).toBe(true);
  });

  it('does not replace a working development installation with a corrupted backup', () => {
    const f = fixture();
    fs.mkdirSync(f.installation.binDirectory, { recursive: true });
    fs.writeFileSync(f.installation.executablePath, 'original binary');
    f.installation.link(f.built, true);
    fs.writeFileSync(path.join(path.dirname(f.installation.snapshotPath), 'previous-binary'), 'damaged backup');
    expect(() => f.installation.unlink()).toThrow('failed its checksum');
    expect(fs.readFileSync(f.installation.executablePath, 'utf8')).toBe('development binary');
    expect(f.installation.status().owned).toBe(true);
  });

  it('rolls back executable replacement if receipt activation fails', () => {
    const f = fixture();
    f.installation.link(f.built);
    const beforeReceipt = fs.readFileSync(f.installation.receiptPath);
    fs.writeFileSync(f.built, 'new binary');
    const rename = fs.renameSync.bind(fs);
    let failed = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === f.installation.receiptPath && !failed) {
        failed = true;
        throw new Error('simulated file lock');
      }
      rename(from, to);
    });
    expect(() => f.installation.link(f.built)).toThrow('previous installation was retained');
    expect(fs.readFileSync(f.installation.executablePath, 'utf8')).toBe('development binary');
    expect(fs.readFileSync(f.installation.receiptPath)).toEqual(beforeReceipt);
    expect(f.installation.status().owned).toBe(true);
  });

  it('rejects missing local engine before touching the installed command', () => {
    const f = fixture();
    fs.unlinkSync(f.engine);
    expect(() => f.installation.link(f.built)).toThrow('Required build file is missing');
    expect(fs.existsSync(f.installation.binDirectory)).toBe(false);
  });

  it('leaves an installation alone when this checkout has no native restore snapshot', () => {
    const f = fixture();
    fs.mkdirSync(f.installation.binDirectory, { recursive: true });
    fs.writeFileSync(f.installation.executablePath, 'unrelated');
    f.installation.unlink();
    expect(fs.readFileSync(f.installation.executablePath, 'utf8')).toBe('unrelated');
  });

  it('rejects concurrent link operations without modifying their lock', () => {
    const f = fixture();
    fs.mkdirSync(f.installation.binDirectory, { recursive: true });
    const lock = path.join(f.installation.binDirectory, '.uapkg-development-link.lock');
    fs.writeFileSync(lock, 'another operation');
    expect(() => f.installation.link(f.built)).toThrow('Another native link operation');
    expect(fs.readFileSync(lock, 'utf8')).toBe('another operation');
  });

  it('remembers whether linking added PATH across rebuilds and preserves later unrelated changes', () => {
    const f = fixture();
    const productionBin = path.join(f.home, '.uapkg', 'bin');
    f.pathState.entries = [productionBin, '/other'];
    expect(f.installation.link(f.built)).toBe(true);
    expect(JSON.parse(fs.readFileSync(f.installation.snapshotPath, 'utf8')).path.preexisting).toBe(false);
    f.pathState.entries.push('/added-after-link');
    fs.writeFileSync(f.built, 'rebuilt');
    expect(f.installation.link(f.built)).toBe(false);
    expect(JSON.parse(fs.readFileSync(f.installation.snapshotPath, 'utf8')).path.preexisting).toBe(false);
    expect(f.installation.unlink()).toBe(true);
    expect(f.pathState.entries).toEqual([productionBin, '/other', '/added-after-link']);
    expect(f.installation.unlink()).toBe(false);
  });

  it('keeps a preexisting PATH entry in place while restoring a prior executable', () => {
    const f = fixture();
    f.pathState.entries = ['/first', f.installation.binDirectory, '/last'];
    fs.mkdirSync(f.installation.binDirectory, { recursive: true });
    fs.writeFileSync(f.installation.executablePath, 'prior installation');
    expect(f.installation.link(f.built, true)).toBe(false);
    expect(f.installation.unlink()).toBe(false);
    expect(f.pathState.entries).toEqual(['/first', f.installation.binDirectory, '/last']);
    expect(fs.readFileSync(f.installation.executablePath, 'utf8')).toBe('prior installation');
  });

  it('does not change PATH without installation ownership', () => {
    const f = fixture();
    f.pathState.entries = [f.installation.binDirectory];
    expect(f.installation.unlink()).toBe(false);
    expect(f.pathManager.restore).not.toHaveBeenCalled();
    f.installation.link(f.built);
    vi.mocked(f.pathManager.restore).mockClear();
    fs.writeFileSync(f.installation.executablePath, 'different owner');
    expect(() => f.installation.unlink()).toThrow('no longer owns');
    expect(f.pathManager.restore).not.toHaveBeenCalled();
    expect(f.pathState.entries).toEqual([f.installation.binDirectory]);
  });

  it.each([false, true])('rolls back a failed PATH addition (partially applied: %s)', (applied) => {
    const f = fixture();
    f.pathState.entries = ['/other'];
    vi.mocked(f.pathManager.add).mockImplementation(() => {
      const recorded = JSON.parse(fs.readFileSync(f.installation.snapshotPath, 'utf8'));
      expect(recorded.path.preexisting).toBe(false);
      if (applied) f.pathState.entries.unshift(f.installation.binDirectory);
      throw new Error('PATH write failed');
    });
    expect(() => f.installation.link(f.built)).toThrow('PATH write failed');
    expect(f.pathState.entries).toEqual(['/other']);
    expect(fs.existsSync(f.installation.executablePath)).toBe(false);
    expect(fs.existsSync(f.installation.snapshotPath)).toBe(false);
  });

  it('retains the working installation and PATH if unlink cannot remove the executable', () => {
    const f = fixture();
    f.installation.link(f.built);
    const remove = fs.rmSync.bind(fs);
    vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
      if (String(file) === f.installation.executablePath) throw new Error('executable is in use');
      remove(file, options);
    });
    expect(() => f.installation.unlink()).toThrow('previous installation was retained');
    expect(f.pathState.entries).toEqual([f.installation.binDirectory]);
    expect(f.installation.status().owned).toBe(true);
  });

  it('keeps the prior snapshot recoverable if a relink and its PATH rollback both fail', () => {
    const f = fixture();
    f.installation.link(f.built);
    const snapshotBefore = fs.readFileSync(f.installation.snapshotPath);
    fs.writeFileSync(f.built, 'new build');
    vi.mocked(f.pathManager.add).mockImplementationOnce(() => {
      throw new Error('PATH add failed');
    });
    vi.mocked(f.pathManager.restore).mockImplementationOnce(() => {
      throw new Error('PATH rollback failed');
    });
    expect(() => f.installation.link(f.built)).toThrow('rollback could not finish');
    expect(f.installation.status().owned).toBe(true);
    expect(fs.readFileSync(f.installation.snapshotPath)).toEqual(snapshotBefore);
    expect(fs.readFileSync(f.installation.executablePath, 'utf8')).toBe('development binary');
    expect(f.installation.unlink()).toBe(true);
    expect(f.pathState.entries).toEqual([]);
  });

  it('can finish interrupted unlink cleanup without removing unrelated PATH entries', () => {
    const f = fixture();
    f.installation.link(f.built);
    const unlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      throw new Error('interrupted snapshot cleanup');
    });
    expect(() => f.installation.unlink()).toThrow('interrupted snapshot cleanup');
    expect(fs.existsSync(f.installation.executablePath)).toBe(false);
    f.pathState.entries.push('/new');
    vi.mocked(fs.unlinkSync).mockImplementation(unlink);
    expect(f.installation.unlink()).toBe(false);
    expect(f.pathState.entries).toEqual(['/new']);
    expect(fs.existsSync(f.installation.snapshotPath)).toBe(false);
  });
});
