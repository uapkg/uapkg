import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { assertPeArchitecture, auditBinaries, parseElfAudit, validateElfAudit } from '../BinaryAudit.ts';

describe('release executable inspection', () => {
  it('records real loader, shared library, and maximum symbol ABI requirements', () => {
    const audit = parseElfAudit(
      'runtime/node',
      `Machine: Advanced Micro Devices X86-64
      [Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]
      0x0001 (NEEDED) Shared library: [libc.so.6]
      0x0001 (NEEDED) Shared library: [libstdc++.so.6]
      0x0000: Version: 1 File: libc.so.6 Cnt: 2
      Name: GLIBC_2.9 Flags: none
      Name: GLIBC_2.39 Flags: none
      Name: GLIBCXX_3.4.30 Flags: none`,
    );
    expect(audit.maximumGlibc).toBe('GLIBC_2.39');
    expect(audit.maximumGlibcxx).toBe('GLIBCXX_3.4.30');
    expect(audit.needed).toEqual(['libc.so.6', 'libstdc++.so.6']);
    expect(() => validateElfAudit(audit, 'linux-x64')).not.toThrow();
    expect(() => validateElfAudit(audit, 'linux-x64-musl')).toThrow('glibc');
    expect(() => validateElfAudit(audit, 'linux-arm64')).toThrow('architecture');
  });

  it('accepts static musl launchers and musl-loaded runtimes without accepting glibc addons', () => {
    const audit = parseElfAudit('uapkg', 'Machine: Advanced Micro Devices X86-64');
    expect(() => validateElfAudit(audit, 'linux-x64-musl')).not.toThrow();
    expect(() =>
      validateElfAudit({ ...audit, interpreter: '/lib/ld-musl-x86_64.so.1' }, 'linux-x64-musl'),
    ).not.toThrow();
    expect(() => validateElfAudit({ ...audit, needed: ['libc.so.6'] }, 'linux-x64-musl')).toThrow('glibc');
    expect(() => validateElfAudit({ ...audit, interpreter: '/lib/ld-musl-x86_64.so.1' }, 'linux-x64')).toThrow(
      'musl interpreter',
    );
  });

  it('checks PE64 architecture independently from Windows distribution naming', () => {
    const bytes = Buffer.alloc(128);
    bytes.write('MZ');
    bytes.writeUInt32LE(64, 60);
    bytes.write('PE\0\0', 64);
    bytes.writeUInt16LE(0x8664, 68);
    bytes.writeUInt16LE(0x20b, 88);
    expect(() => assertPeArchitecture(bytes, 'win-x64')).not.toThrow();
    expect(() => assertPeArchitecture(bytes, 'win-arm64')).toThrow('64-bit PE architecture');
    bytes.writeUInt16LE(0xaa64, 68);
    expect(() => assertPeArchitecture(bytes, 'win-arm64')).not.toThrow();
    bytes.writeUInt16LE(0x10b, 88);
    expect(() => assertPeArchitecture(bytes, 'win-arm64')).toThrow('64-bit PE architecture');
  });

  it('rejects wrong executable formats and unknown targets before invoking host inspection tools', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'uapkg-binary-format-'));
    try {
      const file = path.join(root, 'binary');
      const output = path.join(root, 'evidence.json');
      writeFileSync(file, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      expect(() => auditBinaries(file, 'win-x64', output)).toThrow('ELF binary cannot');
      expect(() => auditBinaries(file, 'linux-arm64-musl', output)).toThrow('Unsupported executable audit target');
      writeFileSync(file, 'MZ');
      expect(() => auditBinaries(file, 'linux-x64', output)).toThrow('Windows PE binary cannot');
      writeFileSync(file, 'not an executable');
      expect(() => auditBinaries(file, 'win-x64', output)).toThrow('primary release executable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
