import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ElfAudit {
  file: string;
  machine: string;
  interpreter: string | null;
  needed: string[];
  symbolVersions: string[];
  maximumGlibc: string | null;
  maximumGlibcxx: string | null;
}

function maximumVersion(values: string[], prefix: string): string | null {
  return (
    values
      .filter((value) => new RegExp(`^${prefix}\\d+(?:\\.\\d+)*$`).test(value))
      .sort((a, b) => {
        const left = a.slice(prefix.length).split('.').map(Number);
        const right = b.slice(prefix.length).split('.').map(Number);
        for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
          const difference = (left[index] ?? 0) - (right[index] ?? 0);
          if (difference) return difference;
        }
        return 0;
      })
      .at(-1) ?? null
  );
}

export function parseElfAudit(file: string, output: string): ElfAudit {
  const symbolVersions = [
    ...new Set([...output.matchAll(/\bName:\s+((?:GLIBC|GLIBCXX|CXXABI)_[\w.]+)/g)].map((match) => match[1]!)),
  ].sort();
  return {
    file,
    machine: /^\s*Machine:\s+(.+)$/m.exec(output)?.[1]?.trim() ?? '',
    interpreter: /\[Requesting program interpreter:\s*([^\]]+)\]/.exec(output)?.[1] ?? null,
    needed: [...output.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map((match) => match[1]!),
    symbolVersions,
    maximumGlibc: maximumVersion(symbolVersions, 'GLIBC_'),
    maximumGlibcxx: maximumVersion(symbolVersions, 'GLIBCXX_'),
  };
}

export function validateElfAudit(audit: ElfAudit, platform: string): void {
  const expectedMachine = platform.includes('arm64') ? 'AArch64' : 'Advanced Micro Devices X86-64';
  if (audit.machine !== expectedMachine)
    throw new Error(`Unexpected ELF architecture for ${audit.file}: ${audit.machine}.`);
  if (platform.endsWith('-musl')) {
    if (
      audit.maximumGlibc ||
      audit.needed.some((name) => /^(?:libc|libm|libpthread|libdl|librt)\.so\.[0-9]/.test(name)) ||
      (audit.interpreter !== null && audit.interpreter !== '/lib/ld-musl-x86_64.so.1')
    )
      throw new Error(`The musl artifact contains a glibc or incompatible loader dependency: ${audit.file}.`);
  } else if (audit.interpreter?.includes('musl')) {
    throw new Error(`The glibc artifact contains a musl interpreter: ${audit.file}.`);
  }
}

export function assertPeArchitecture(bytes: Buffer, platform: string): void {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Expected a Windows PE executable.');
  const offset = bytes.readUInt32LE(60);
  if (offset + 26 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0')
    throw new Error('Invalid Windows PE header.');
  const expected = platform === 'win-x64' ? 0x8664 : platform === 'win-arm64' ? 0xaa64 : 0;
  if (!expected || bytes.readUInt16LE(offset + 4) !== expected || bytes.readUInt16LE(offset + 24) !== 0x20b)
    throw new Error(`Expected the 64-bit PE architecture for ${platform}.`);
}

function files(root: string): string[] {
  if (statSync(root).isFile()) return [root];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
  });
}

export function auditBinaries(root: string, platform: string, output: string): void {
  if (!['win-x64', 'win-arm64', 'linux-x64', 'linux-arm64', 'linux-x64-musl'].includes(platform))
    throw new Error(`Unsupported executable audit target: ${platform}.`);
  const absoluteRoot = path.resolve(root);
  let primary = absoluteRoot;
  if (statSync(absoluteRoot).isDirectory()) {
    const descriptor = JSON.parse(readFileSync(path.join(absoluteRoot, 'engine.json'), 'utf8')) as {
      executable?: string;
    };
    if (typeof descriptor.executable !== 'string' || path.isAbsolute(descriptor.executable))
      throw new Error('Executable audit requires a relative primary engine executable.');
    primary = path.resolve(absoluteRoot, descriptor.executable);
    if (!primary.startsWith(`${absoluteRoot}${path.sep}`))
      throw new Error('The primary engine executable escapes its directory.');
  }
  let inspectedPrimary = false;
  const binaries: (ElfAudit | { file: string; format: 'PE'; platform: string })[] = [];
  for (const file of files(absoluteRoot)) {
    const bytes = readFileSync(file);
    if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      if (!platform.startsWith('linux-'))
        throw new Error(`An ELF binary cannot be published for ${platform}: ${file}.`);
      const result = spawnSync(
        'readelf',
        ['--wide', '--file-header', '--program-headers', '--dynamic', '--version-info', file],
        { encoding: 'utf8', timeout: 30_000 },
      );
      if (result.error || result.status !== 0)
        throw new Error(`ELF inspection failed for ${file}: ${result.error?.message ?? result.stderr}`);
      const audit = parseElfAudit(path.relative(path.resolve(root), file) || path.basename(file), result.stdout);
      validateElfAudit(audit, platform);
      // Native addons legitimately contain unresolved Node symbols; missing libraries are never acceptable.
      if (audit.needed.length || audit.interpreter) {
        const linked = spawnSync('ldd', [file], { encoding: 'utf8', timeout: 30_000 });
        if (linked.error || /(?:=>\s*not found|Error loading shared library)/.test(`${linked.stdout}${linked.stderr}`))
          throw new Error(
            `A runtime library is unavailable for ${audit.file}: ${linked.error?.message ?? `${linked.stdout}${linked.stderr}`}`,
          );
      }
      binaries.push(audit);
      inspectedPrimary ||= file === primary;
    } else if (bytes.subarray(0, 2).toString('ascii') === 'MZ') {
      if (!platform.startsWith('win-'))
        throw new Error(`A Windows PE binary cannot be published for ${platform}: ${file}.`);
      assertPeArchitecture(bytes, platform);
      binaries.push({ file: path.relative(path.resolve(root), file) || path.basename(file), format: 'PE', platform });
      inspectedPrimary ||= file === primary;
    }
  }
  if (!inspectedPrimary) throw new Error(`The primary release executable was not inspected: ${primary}.`);
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
  const musl = platform.endsWith('-musl')
    ? spawnSync('/lib/ld-musl-x86_64.so.1', [], { encoding: 'utf8' }).stderr
    : undefined;
  const distribution = process.platform === 'linux' ? readFileSync('/etc/os-release', 'utf8') : undefined;
  const systemPackages = distribution?.includes('ID=alpine')
    ? spawnSync(
        'apk',
        ['info', '-v', '-e', 'musl', 'libatomic', 'libstdc++', 'libgcc', 'libsecret', 'dbus', 'gnome-keyring'],
        { encoding: 'utf8' },
      )
        .stdout.trim()
        .split('\n')
    : undefined;
  mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  writeFileSync(
    output,
    `${JSON.stringify({ schemaVersion: 1, platform, kernel: os.release(), distribution, glibcRuntime: report.header?.glibcVersionRuntime, muslRuntime: musl, systemPackages, binaries }, null, 2)}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    const [root, platform, output] = process.argv.slice(2);
    if (!root || !platform || !output) throw new Error('Expected <binary-or-directory> <platform> <report.json>.');
    auditBinaries(root, platform, output);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
