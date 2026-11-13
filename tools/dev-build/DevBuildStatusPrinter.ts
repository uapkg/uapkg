import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { UAPKGBuildMode } from '@uapkg/common';
import type { NativeInstallStatus } from './types.ts';

export type UapkgProfileRoots = Readonly<Record<UAPKGBuildMode, string>>;

export function resolveUapkgProfileRoots(homeDirectory = os.homedir()): UapkgProfileRoots {
  return {
    production: path.join(homeDirectory, '.uapkg'),
    development: path.join(homeDirectory, '.uapkg-development'),
  };
}

export function resolveUapkgCommands(): string[] {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const results = spawnSync(command, ['uapkg'], { encoding: 'utf8', windowsHide: true });
  const paths = (results.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (process.platform === 'win32') {
    const powershell = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-Command uapkg -ErrorAction SilentlyContinue).Source'],
      { encoding: 'utf8', windowsHide: true },
    );
    const selected = powershell.stdout?.trim();
    if (selected) paths.unshift(selected);
  }
  return [...new Set(paths)];
}

export class DevBuildStatusPrinter {
  private readonly profileRoots: UapkgProfileRoots;
  private readonly resolveCommands: () => string[];

  constructor(profileRoots = resolveUapkgProfileRoots(), resolveCommands = resolveUapkgCommands) {
    this.profileRoots = profileRoots;
    this.resolveCommands = resolveCommands;
  }

  printStatus(status: NativeInstallStatus): void {
    console.log(`Dev Mode: ${status.owned ? 'ACTIVE' : 'INACTIVE'}`);
    console.log(`Production Profile Root: ${this.profileRoots.production}`);
    console.log(`Development Profile Root: ${this.profileRoots.development}`);
    console.log(`Native Launcher: ${status.installed ? status.executablePath : 'not installed'}`);
    console.log(`Install Receipt: ${status.receiptPath}`);
    console.log(`Restore Snapshot: ${status.snapshotPath}`);
    if (status.receipt) {
      console.log(`Checkout: ${status.receipt.development.checkoutPath}`);
      console.log(`Local Engine: ${status.receipt.development.enginePath}`);
      console.log(`Node: ${status.receipt.development.nodePath}`);
    }
    const normalize = (value: string) =>
      process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    const onPath = (process.env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .some((value) => normalize(value) === normalize(status.binDirectory));
    const pathEntry = onPath ? (status.installed ? 'yes' : 'yes (directory entry only; launcher not installed)') : 'no';
    console.log(`Launcher Directory In PATH: ${pathEntry}`);
    const commands = this.resolveCommands();
    console.log(`Resolved Command: ${commands[0] ?? 'not found'}`);
    if (status.installed && !onPath)
      console.log('[dev-build] Run vp run build:link to check the user PATH, then open a new terminal.');
    if (status.installed && commands[0] && normalize(commands[0]) !== normalize(status.executablePath)) {
      console.log(
        `[dev-build] Another command takes precedence: ${commands[0]}. Put the native launcher directory first in PATH.`,
      );
    }
  }
}
