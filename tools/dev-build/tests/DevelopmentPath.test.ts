import { describe, expect, it, vi } from 'vite-plus/test';
import {
  createPosixDevelopmentPath,
  createWindowsDevelopmentPath,
  isDevelopmentPathSnapshot,
  type PosixPathBackend,
  type WindowsPathValue,
} from '../DevelopmentPath.ts';

const directory = 'C:\\Users\\Example\\.uapkg-development\\bin';

function windowsFixture(value = ';C:\\Existing;;%APPDATA%\\npm;', kind: WindowsPathValue['kind'] = 'ExpandString') {
  let persistent: WindowsPathValue = { exists: true, value, kind };
  const environment = { Path: 'C:\\Windows;C:\\Tools', USERPROFILE: 'C:\\Users\\Example' };
  const backend = {
    read: vi.fn(() => ({ ...persistent })),
    write: vi.fn((next: WindowsPathValue) => {
      persistent = { ...next };
    }),
  };
  return {
    manager: createWindowsDevelopmentPath(backend, environment),
    backend,
    environment,
    get persistent() {
      return persistent;
    },
    set persistent(next: WindowsPathValue) {
      persistent = next;
    },
  };
}

describe('Windows development PATH ownership', () => {
  it.each(['String', 'ExpandString'] as const)(
    'preserves unrelated raw entries, edits and the %s registry kind',
    (kind) => {
      const initial = ';C:\\Existing;;%APPDATA%\\npm;';
      const fixture = windowsFixture(initial, kind);
      const snapshot = fixture.manager.capture(directory);
      expect(snapshot).toMatchObject({ preexisting: false, processPreexisting: false });
      expect(fixture.manager.add(directory)).toBe(true);
      expect(fixture.persistent).toEqual({ exists: true, value: `${directory};${initial}`, kind });
      expect(fixture.environment.Path).toBe(`${directory};C:\\Windows;C:\\Tools`);
      fixture.persistent = { ...fixture.persistent, value: `${fixture.persistent.value};C:\\AddedLater` };
      expect(fixture.manager.restore(directory, snapshot)).toBe(true);
      expect(fixture.persistent).toEqual({ exists: true, value: `${initial};C:\\AddedLater`, kind });
      expect(fixture.environment.Path).toBe('C:\\Windows;C:\\Tools');
      expect(fixture.manager.restore(directory, snapshot)).toBe(false);
    },
  );

  it('keeps all preexisting equivalent entries in their original spelling and position', () => {
    const original = `C:\\Before;  "%userprofile%\\.uapkg-development\\bin\\"  ;;${directory.toUpperCase()};C:\\After`;
    const fixture = windowsFixture(original);
    const snapshot = fixture.manager.capture(directory);
    expect(snapshot.preexisting).toBe(true);
    expect(fixture.manager.add(directory)).toBe(false);
    expect(fixture.persistent.value).toBe(original);
    expect(fixture.environment.Path).toBe(`${directory};C:\\Windows;C:\\Tools`);
    expect(fixture.manager.restore(directory, snapshot)).toBe(false);
    expect(fixture.persistent.value).toBe(original);
    expect(fixture.environment.Path).toBe('C:\\Windows;C:\\Tools');
    expect(fixture.backend.write).not.toHaveBeenCalled();
  });

  it('preserves a process-only entry that existed before linking', () => {
    const fixture = windowsFixture('C:\\UserTools');
    fixture.environment.Path = `C:\\Windows;${directory}\\;C:\\Tools`;
    const originalProcessPath = fixture.environment.Path;
    const snapshot = fixture.manager.capture(directory);
    expect(snapshot).toMatchObject({ preexisting: false, processPreexisting: true });
    fixture.manager.add(directory);
    fixture.manager.restore(directory, snapshot);
    expect(fixture.persistent.value).toBe('C:\\UserTools');
    expect(fixture.environment.Path).toBe(originalProcessPath);
  });

  it('removes only its literal inserted entry and preserves later equivalent user additions', () => {
    const fixture = windowsFixture('C:\\UserTools');
    const snapshot = fixture.manager.capture(directory);
    fixture.manager.add(directory);
    fixture.persistent = {
      ...fixture.persistent,
      value: `${fixture.persistent.value};%USERPROFILE%\\.uapkg-development\\bin`,
    };
    fixture.manager.restore(directory, snapshot);
    expect(fixture.persistent.value).toBe('C:\\UserTools;%USERPROFILE%\\.uapkg-development\\bin');
    expect(fixture.manager.restore(directory, snapshot)).toBe(false);
  });

  it('adds to an absent user PATH without importing the inherited machine PATH', () => {
    const fixture = windowsFixture();
    fixture.persistent = { exists: false, value: '', kind: 'ExpandString' };
    fixture.manager.add(directory);
    expect(fixture.persistent).toEqual({ exists: true, value: directory, kind: 'ExpandString' });
    expect(fixture.environment.Path).toContain('C:\\Windows');
  });

  it('updates the current process only after a successful persistent write', () => {
    const fixture = windowsFixture('C:\\UserTools');
    const snapshot = fixture.manager.capture(directory);
    fixture.backend.write.mockImplementationOnce(() => {
      throw new Error('denied');
    });
    expect(() => fixture.manager.add(directory)).toThrow('denied');
    expect(fixture.environment.Path).toBe('C:\\Windows;C:\\Tools');
    fixture.manager.add(directory);
    fixture.backend.write.mockImplementationOnce(() => {
      throw new Error('denied');
    });
    expect(() => fixture.manager.restore(directory, snapshot)).toThrow('denied');
    expect(fixture.environment.Path).toBe(`${directory};C:\\Windows;C:\\Tools`);
  });

  it('validates snapshot ownership before changing either PATH', () => {
    const fixture = windowsFixture();
    const snapshot = fixture.manager.capture(directory);
    expect(isDevelopmentPathSnapshot(JSON.parse(JSON.stringify(snapshot)))).toBe(true);
    expect(isDevelopmentPathSnapshot({ ...snapshot, processPreexisting: undefined })).toBe(false);
    expect(isDevelopmentPathSnapshot({ ...snapshot, platform: 'win32', profilePath: '/other' })).toBe(false);
    expect(() => fixture.manager.restore('D:\\Other', snapshot)).toThrow('does not belong');
    expect(fixture.backend.write).not.toHaveBeenCalled();
  });

  it.each(['relative\\bin', 'C:\\bin;C:\\other', 'C:\\bin\nother'])(
    'rejects an invalid directory %s before persistence',
    (invalid) => {
      const fixture = windowsFixture();
      expect(() => fixture.manager.add(invalid)).toThrow('must be absolute');
      expect(fixture.backend.read).not.toHaveBeenCalled();
      expect(fixture.backend.write).not.toHaveBeenCalled();
    },
  );
});

function posixFixture(shell: PosixPathBackend['shell'] = 'bash', initial = '# user settings without a final newline') {
  let contents = initial;
  const environment = { PATH: '/usr/bin:/user/bin' };
  const backend = {
    shell,
    profilePath: '/home/example/.shellrc',
    read: vi.fn(() => contents),
    write: vi.fn((next: string) => {
      contents = next;
    }),
  };
  return {
    manager: createPosixDevelopmentPath(backend, environment),
    backend,
    environment,
    get contents() {
      return contents;
    },
    set contents(next: string) {
      contents = next;
    },
  };
}

describe('POSIX development PATH ownership', () => {
  const directory = '/home/example/.uapkg-development/bin';

  it.each(['bash', 'zsh', 'fish'] as const)(
    'adds and removes only its %s block while preserving later profile edits',
    (shell) => {
      const initial = 'export FOO=1';
      const fixture = posixFixture(shell, initial);
      const snapshot = fixture.manager.capture(directory);
      expect(isDevelopmentPathSnapshot(JSON.parse(JSON.stringify(snapshot)))).toBe(true);
      expect(fixture.manager.add(directory)).toBe(true);
      expect(fixture.contents).toContain('# >>> uapkg development PATH');
      expect(fixture.contents).toContain(shell === 'fish' ? 'if not contains --' : 'case ":$PATH:" in');
      expect(fixture.manager.add(directory)).toBe(false);
      fixture.contents += 'export BAR=2\n';
      expect(fixture.manager.restore(directory, snapshot)).toBe(true);
      expect(fixture.contents).toBe(`${initial}\nexport BAR=2\n`);
      expect(fixture.environment.PATH).toBe('/usr/bin:/user/bin');
      expect(fixture.manager.restore(directory, snapshot)).toBe(false);
    },
  );

  it('preserves an existing managed block across link and restore', () => {
    const fixture = posixFixture();
    fixture.manager.add(directory);
    const original = fixture.contents;
    const snapshot = fixture.manager.capture(directory);
    expect(snapshot).toMatchObject({ preexisting: true, processPreexisting: true });
    expect(fixture.manager.add(directory)).toBe(false);
    expect(fixture.manager.restore(directory, snapshot)).toBe(false);
    expect(fixture.contents).toBe(original);
    expect(fixture.backend.write).toHaveBeenCalledTimes(1);
  });

  it('leaves a user-modified managed block untouched', () => {
    const fixture = posixFixture();
    const snapshot = fixture.manager.capture(directory);
    fixture.manager.add(directory);
    fixture.contents = fixture.contents.replace('export PATH=', 'export CUSTOM_PATH=');
    const edited = fixture.contents;
    expect(fixture.manager.restore(directory, snapshot)).toBe(false);
    expect(fixture.contents).toBe(edited);
  });

  it('preserves preexisting process membership and safely quotes shell metacharacters', () => {
    const unusual = "/home/example/user's $(commands)/bin";
    const fixture = posixFixture();
    fixture.environment.PATH += `:${unusual}`;
    const original = fixture.environment.PATH;
    const snapshot = fixture.manager.capture(unusual);
    fixture.manager.add(unusual);
    expect(fixture.contents).toContain("'/home/example/user'\\''s $(commands)/bin'");
    fixture.manager.restore(unusual, snapshot);
    expect(fixture.environment.PATH).toBe(original);
  });

  it('does not change process PATH when profile persistence fails', () => {
    const fixture = posixFixture();
    fixture.backend.write.mockImplementationOnce(() => {
      throw new Error('denied');
    });
    expect(() => fixture.manager.add(directory)).toThrow('denied');
    expect(fixture.environment.PATH).toBe('/usr/bin:/user/bin');
  });

  it('rejects a restore snapshot for another shell profile', () => {
    const fixture = posixFixture();
    const snapshot = fixture.manager.capture(directory);
    expect(() => fixture.manager.restore(directory, { ...snapshot, profilePath: '/home/other/.bashrc' })).toThrow(
      'does not belong',
    );
    expect(fixture.backend.write).not.toHaveBeenCalled();
  });
});
