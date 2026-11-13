import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { DevBuildStatusPrinter, resolveUapkgProfileRoots } from '../DevBuildStatusPrinter.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('native development status', () => {
  it('keeps production and development profile roots distinct', () => {
    expect(resolveUapkgProfileRoots('D:/Users/example')).toEqual({
      production: path.join('D:/Users/example', '.uapkg'),
      development: path.join('D:/Users/example', '.uapkg-development'),
    });
  });

  it('reports the actual selected PowerShell shim instead of claiming the native launcher is active', () => {
    vi.stubEnv('PATH', '/profiles/.uapkg-development/bin');
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const printer = new DevBuildStatusPrinter(
      { production: '/profiles/.uapkg', development: '/profiles/.uapkg-development' },
      () => ['/old-bin/uapkg.ps1'],
    );
    printer.printStatus({
      binDirectory: '/profiles/.uapkg-development/bin',
      executablePath: '/profiles/.uapkg-development/bin/uapkg.exe',
      receiptPath: '/profiles/.uapkg-development/bin/uapkg-install.json',
      snapshotPath: '/checkout/snapshot.json',
      installed: true,
      owned: true,
      receipt: null,
    });
    expect(lines).toContain('Development Profile Root: /profiles/.uapkg-development');
    expect(lines).toContain('Production Profile Root: /profiles/.uapkg');
    expect(lines).toContain('Resolved Command: /old-bin/uapkg.ps1');
    expect(lines.some((line) => line.includes('Another command takes precedence'))).toBe(true);
  });

  it.each([
    {
      description: 'its directory remains on PATH but no command resolves',
      pathEntries: ['/profiles/.uapkg-development/bin'],
      resolved: [],
      pathStatus: 'yes (directory entry only; launcher not installed)',
      selectedCommand: 'not found',
    },
    {
      description: 'its directory is absent from PATH and a production command resolves',
      pathEntries: ['/production/bin'],
      resolved: ['/production/bin/uapkg.exe'],
      pathStatus: 'no',
      selectedCommand: '/production/bin/uapkg.exe',
    },
  ])(
    'reports an unlinked launcher accurately when $description',
    ({ pathEntries, resolved, pathStatus, selectedCommand }) => {
      vi.stubEnv('PATH', pathEntries.join(path.delimiter));
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
      const printer = new DevBuildStatusPrinter(
        { production: '/profiles/.uapkg', development: '/profiles/.uapkg-development' },
        () => resolved,
      );
      printer.printStatus({
        binDirectory: '/profiles/.uapkg-development/bin',
        executablePath: '/profiles/.uapkg-development/bin/uapkg.exe',
        receiptPath: '/profiles/.uapkg-development/bin/uapkg-install.json',
        snapshotPath: '/checkout/snapshot.json',
        installed: false,
        owned: false,
        receipt: null,
      });
      expect(lines).toContain('Dev Mode: INACTIVE');
      expect(lines).toContain('Native Launcher: not installed');
      expect(lines).toContain(`Launcher Directory In PATH: ${pathStatus}`);
      expect(lines).toContain(`Resolved Command: ${selectedCommand}`);
      expect(lines.some((line) => line.includes('[dev-build] Add '))).toBe(false);
      expect(lines.some((line) => line.includes('Another command takes precedence'))).toBe(false);
    },
  );
});
