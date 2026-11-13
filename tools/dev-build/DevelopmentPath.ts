import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DevelopmentPathSnapshot {
  schemaVersion: 1;
  platform: 'win32' | 'posix';
  directory: string;
  preexisting: boolean;
  processPreexisting: boolean;
  profilePath?: string;
}

export interface DevelopmentPath {
  capture(directory: string): DevelopmentPathSnapshot;
  /** Returns whether persistent configuration changed. */
  add(directory: string): boolean;
  /** Preserves preexisting entries and changes made by other owners. */
  restore(directory: string, snapshot: DevelopmentPathSnapshot): boolean;
}

export interface WindowsPathValue {
  exists: boolean;
  value: string;
  kind: 'String' | 'ExpandString';
}

export interface WindowsPathBackend {
  read(): WindowsPathValue;
  write(value: WindowsPathValue): void;
}

export interface PosixPathBackend {
  profilePath: string;
  shell: 'bash' | 'zsh' | 'fish';
  read(): string;
  write(contents: string): void;
}

export function isDevelopmentPathSnapshot(value: unknown): value is DevelopmentPathSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const snapshot = value as Partial<DevelopmentPathSnapshot>;
  if (
    snapshot.schemaVersion !== 1 ||
    typeof snapshot.directory !== 'string' ||
    typeof snapshot.preexisting !== 'boolean' ||
    typeof snapshot.processPreexisting !== 'boolean'
  )
    return false;
  if (snapshot.platform === 'win32') {
    return path.win32.isAbsolute(snapshot.directory) && snapshot.profilePath === undefined;
  }
  return (
    snapshot.platform === 'posix' &&
    path.posix.isAbsolute(snapshot.directory) &&
    typeof snapshot.profilePath === 'string' &&
    path.posix.isAbsolute(snapshot.profilePath)
  );
}

function environmentKey(environment: NodeJS.ProcessEnv, name: string): string {
  return Object.keys(environment).find((key) => key.toLowerCase() === name.toLowerCase()) ?? name;
}

function expandWindowsVariables(value: string, environment: NodeJS.ProcessEnv): string {
  for (let count = 0; count < 10; count++) {
    const expanded = value.replace(
      /%([^%]+)%/g,
      (original, name: string) => environment[environmentKey(environment, name)] ?? original,
    );
    if (expanded === value) break;
    value = expanded;
  }
  return value;
}

function windowsIdentity(value: string, environment: NodeJS.ProcessEnv): string | null {
  value = value.trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  value = expandWindowsVariables(value, environment);
  if (!path.win32.isAbsolute(value)) return null;
  let normalized = path.win32.normalize(value);
  const rootLength = path.win32.parse(normalized).root.length;
  while (normalized.length > rootLength && /[\\/]$/.test(normalized)) normalized = normalized.slice(0, -1);
  return normalized.toLowerCase();
}

function removeOneEntry(entries: string[], ownedEntry: string): boolean {
  const index = entries.indexOf(ownedEntry);
  if (index === -1) return false;
  entries.splice(index, 1);
  return true;
}

export function createWindowsDevelopmentPath(
  backend: WindowsPathBackend,
  environment: NodeJS.ProcessEnv,
): DevelopmentPath {
  const identity = (value: string) => windowsIdentity(value, environment);
  const requireDirectory = (directory: string) => {
    if (!path.win32.isAbsolute(directory) || /[;\r\n]/.test(directory)) {
      throw new Error('[dev-build] Development PATH directory must be absolute and contain no PATH separator.');
    }
  };
  const contains = (entries: string[], directory: string) =>
    entries.some((entry) => identity(entry) === identity(directory));
  const processEntries = () => (environment[environmentKey(environment, 'PATH')] ?? '').split(';');
  const addProcessEntry = (directory: string) => {
    const entries = processEntries();
    if (!contains(entries, directory)) {
      environment[environmentKey(environment, 'PATH')] = [directory, ...entries].join(';');
    }
  };
  return {
    capture(directory) {
      requireDirectory(directory);
      const current = backend.read();
      return {
        schemaVersion: 1,
        platform: 'win32',
        directory,
        preexisting: current.exists && contains(current.value.split(';'), directory),
        processPreexisting: contains(processEntries(), directory),
      };
    },
    add(directory) {
      requireDirectory(directory);
      const current = backend.read();
      const entries = current.exists ? current.value.split(';') : [];
      const changed = !contains(entries, directory);
      if (changed) backend.write({ ...current, exists: true, value: [directory, ...entries].join(';') });
      addProcessEntry(directory);
      return changed;
    },
    restore(directory, snapshot) {
      requireDirectory(directory);
      if (
        !isDevelopmentPathSnapshot(snapshot) ||
        snapshot.platform !== 'win32' ||
        identity(snapshot.directory) !== identity(directory)
      ) {
        throw new Error('[dev-build] The saved PATH state does not belong to this development directory.');
      }
      let changed = false;
      if (!snapshot.preexisting) {
        const current = backend.read();
        const entries = current.exists ? current.value.split(';') : [];
        changed = removeOneEntry(entries, snapshot.directory);
        if (changed) backend.write({ ...current, value: entries.join(';') });
      }
      if (!snapshot.processPreexisting) {
        const entries = processEntries();
        if (removeOneEntry(entries, snapshot.directory)) {
          environment[environmentKey(environment, 'PATH')] = entries.join(';');
        }
      }
      return changed;
    },
  };
}

function posixBlock(directory: string, shell: PosixPathBackend['shell']): { marker: string; text: string } {
  const id = createHash('sha256').update(directory).digest('hex').slice(0, 16);
  const marker = `# >>> uapkg development PATH ${id} >>>`;
  const quoted =
    shell === 'fish'
      ? `'${directory.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
      : `'${directory.replaceAll("'", "'\\''")}'`;
  const body =
    shell === 'fish'
      ? `if not contains -- ${quoted} $PATH\n    set -gx PATH ${quoted} $PATH\nend`
      : `case ":$PATH:" in\n  *:${quoted}:*) ;;\n  *) export PATH=${quoted}:"$PATH" ;;\nesac`;
  return { marker, text: `\n${marker}\n${body}\n# <<< uapkg development PATH ${id} <<<\n` };
}

export function createPosixDevelopmentPath(backend: PosixPathBackend, environment: NodeJS.ProcessEnv): DevelopmentPath {
  const requireDirectory = (directory: string) => {
    if (!path.posix.isAbsolute(directory) || /[:\r\n]/.test(directory)) {
      throw new Error('[dev-build] Development PATH directory must be absolute and contain no PATH separator.');
    }
  };
  const processEntries = () => (environment.PATH ?? '').split(':');
  const contains = (directory: string) =>
    processEntries().some(
      (entry) => entry && path.posix.normalize(entry).replace(/\/$/, '') === directory.replace(/\/$/, ''),
    );
  return {
    capture(directory) {
      requireDirectory(directory);
      return {
        schemaVersion: 1,
        platform: 'posix',
        directory,
        profilePath: backend.profilePath,
        preexisting: backend.read().includes(posixBlock(directory, backend.shell).marker),
        processPreexisting: contains(directory),
      };
    },
    add(directory) {
      requireDirectory(directory);
      const current = backend.read();
      const block = posixBlock(directory, backend.shell);
      const changed = !current.includes(block.marker);
      if (changed) backend.write(current + block.text);
      if (!contains(directory)) environment.PATH = [directory, ...processEntries()].join(':');
      return changed;
    },
    restore(directory, snapshot) {
      requireDirectory(directory);
      if (
        !isDevelopmentPathSnapshot(snapshot) ||
        snapshot.platform !== 'posix' ||
        snapshot.directory !== directory ||
        snapshot.profilePath !== backend.profilePath
      ) {
        throw new Error('[dev-build] The saved PATH state does not belong to this development shell profile.');
      }
      let changed = false;
      if (!snapshot.preexisting) {
        const current = backend.read();
        const block = posixBlock(directory, backend.shell).text;
        const index = current.indexOf(block);
        if (index !== -1) {
          const before = current.slice(0, index);
          const after = current.slice(index + block.length);
          const separator = before && after && !before.endsWith('\n') && !after.startsWith('\n') ? '\n' : '';
          backend.write(before + separator + after);
          changed = true;
        }
      }
      if (!snapshot.processPreexisting) {
        const entries = processEntries();
        if (removeOneEntry(entries, snapshot.directory)) environment.PATH = entries.join(':');
      }
      return changed;
    },
  };
}

const readWindowsPathScript = `
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
try {
  $value = if ($null -eq $key) { $null } else { $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  if ($null -eq $value) { @{ exists = $false; value = ''; kind = 'ExpandString' } | ConvertTo-Json -Compress }
  else {
    $kind = $key.GetValueKind('Path').ToString()
    if ($kind -notin @('String', 'ExpandString') -or $value -isnot [string]) { throw 'User PATH must be a registry string.' }
    @{ exists = $true; value = $value; kind = $kind } | ConvertTo-Json -Compress
  }
} finally { if ($null -ne $key) { $key.Dispose() } }
`;

const writeWindowsPathScript = `
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $kind = [System.Enum]::Parse([Microsoft.Win32.RegistryValueKind], $env:UAPKG_DEVELOPMENT_PATH_KIND)
  $key.SetValue('Path', [string]$env:UAPKG_DEVELOPMENT_PATH_VALUE, $kind)
} finally { $key.Dispose() }
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class UapkgEnvironmentChange {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr parameter, string value, uint flags, uint timeout, out UIntPtr result);
}
'@
  $result = [UIntPtr]::Zero
  [void][UapkgEnvironmentChange]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 1000, [ref]$result)
} catch { }
`;

function runWindowsScript(script: string, environment: NodeJS.ProcessEnv = process.env): string {
  const shell = path.win32.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const utf8Script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n${script}`;
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', utf8Script], {
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `[dev-build] Could not update or read the user PATH: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

export function createDevelopmentPath(): DevelopmentPath {
  if (process.platform === 'win32') {
    return createWindowsDevelopmentPath(
      {
        read() {
          const value = JSON.parse(runWindowsScript(readWindowsPathScript)) as WindowsPathValue;
          if (
            typeof value.exists !== 'boolean' ||
            typeof value.value !== 'string' ||
            !['String', 'ExpandString'].includes(value.kind)
          ) {
            throw new Error('[dev-build] Could not read a valid user PATH registry value.');
          }
          return value;
        },
        write(value) {
          runWindowsScript(writeWindowsPathScript, {
            ...process.env,
            UAPKG_DEVELOPMENT_PATH_VALUE: value.value,
            UAPKG_DEVELOPMENT_PATH_KIND: value.kind,
          });
        },
      },
      process.env,
    );
  }
  const home = os.homedir();
  const shellName = path.basename(process.env.SHELL ?? 'bash');
  const shell = shellName === 'fish' ? 'fish' : shellName === 'zsh' ? 'zsh' : 'bash';
  const profilePath =
    shell === 'fish'
      ? path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'fish', 'config.fish')
      : path.join(shell === 'zsh' ? (process.env.ZDOTDIR ?? home) : home, shell === 'zsh' ? '.zshrc' : '.bashrc');
  return createPosixDevelopmentPath(
    {
      shell,
      profilePath,
      read() {
        try {
          return fs.readFileSync(profilePath, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
          throw error;
        }
      },
      write(contents) {
        const destination = fs.lstatSync(profilePath, { throwIfNoEntry: false })
          ? fs.realpathSync(profilePath)
          : profilePath;
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const mode = fs.statSync(destination, { throwIfNoEntry: false })?.mode ?? 0o600;
        const temporary = `${destination}.${randomUUID()}.tmp`;
        try {
          fs.writeFileSync(temporary, contents, { flag: 'wx', mode });
          fs.renameSync(temporary, destination);
        } finally {
          fs.rmSync(temporary, { force: true });
        }
      },
    },
    process.env,
  );
}
