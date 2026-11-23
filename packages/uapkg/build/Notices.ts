import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NOTICE_FILENAME = 'THIRD-PARTY-NOTICES.txt';

export interface SbomLicenseChoice {
  expression?: string;
  license?: { id?: string; name?: string; url?: string };
}

export function hasDeclaredLicense(component: { licenses?: readonly SbomLicenseChoice[] }): boolean {
  return (
    component.licenses?.some(({ license, expression }) =>
      [license?.id, license?.name, expression].some((value) => {
        const label = value?.trim();
        return Boolean(
          label && !/^(?:NOASSERTION|NONE|UNKNOWN|UNLICENSED|N\/A|UNSPECIFIED|SEE\s+LICENSE\s+IN\s+.+)$/i.test(label),
        );
      }),
    ) ?? false
  );
}

interface Component {
  purl?: string;
  licenses?: SbomLicenseChoice[];
  externalReferences?: { type: string; url: string }[];
  components?: Component[];
}

interface NpmSbom {
  metadata?: { component?: Component };
  components?: Component[];
}

type LicenseOverrides = Record<string, { id: string; references: string[] }>;

/** Apply only reviewed grants for exact versions already present in npm's inventory. */
export function applyLicenseOverrides(report: NpmSbom, overrides: LicenseOverrides): boolean {
  const pending = [...(report.components ?? [])];
  if (report.metadata?.component) pending.push(report.metadata.component);
  let changed = false;
  for (const component of pending) {
    if (component.components) pending.push(...component.components);
    const override = component.purl && overrides[component.purl];
    if (!override || hasDeclaredLicense(component)) continue;
    const references = [...new Set(override.references)];
    if (!override.id?.trim() || !references.length || references.some((url) => !URL.canParse(url))) {
      throw new Error(`License override for ${component.purl} requires a license ID and upstream reference URLs.`);
    }
    component.licenses = [{ license: { id: override.id, url: references[0] } }];
    const existing = (component.externalReferences ??= []);
    for (const url of references) {
      if (!existing.some((ref) => ref.type === 'license' && ref.url === url)) existing.push({ type: 'license', url });
    }
    changed = true;
  }
  return changed;
}

export function npmCliPath(): string {
  const executableDirectory = path.dirname(process.execPath);
  const candidates = [
    path.join(executableDirectory, 'node_modules/npm/bin/npm-cli.js'),
    path.join(executableDirectory, '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error('The release Node installation must include npm.');
  return found;
}

/** The published package describes all locked platforms;
 * standalone builds describe only what npm installed on the release target. */
export function writeNpmSbom(packageRoot: string, mode: 'lockfile' | 'installed', npmVersion: string): void {
  const source = path.resolve(packageRoot);
  const scratch = mode === 'lockfile' ? mkdtempSync(path.join(os.tmpdir(), 'uapkg-sbom-')) : undefined;
  const directory = scratch ?? source;
  try {
    if (scratch) {
      copyFileSync(path.join(source, 'package.json'), path.join(scratch, 'package.json'));
      copyFileSync(path.join(source, 'dist/runtime-lock.json'), path.join(scratch, 'package-lock.json'));
    }
    const cli = npmCliPath();
    const installed = JSON.parse(readFileSync(path.resolve(path.dirname(cli), '../package.json'), 'utf8'));
    const bootstrap =
      installed.version === npmVersion
        ? []
        : ['exec', '--yes', '--prefer-offline', `--package=npm@${npmVersion}`, '--', 'npm'];
    const report = execFileSync(
      process.execPath,
      [
        cli,
        ...bootstrap,
        'sbom',
        '--prefix',
        directory,
        '--workspaces=false',
        '--sbom-format=cyclonedx',
        '--sbom-type=application',
        '--omit=dev',
        `--package-lock-only=${mode === 'lockfile'}`,
      ],
      { cwd: directory, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, maxBuffer: 16 * 1024 * 1024 },
    );
    const document: NpmSbom = JSON.parse(report.toString('utf8'));
    const overrides: LicenseOverrides = JSON.parse(
      readFileSync(new URL('../../../tools/release/license-overrides.json', import.meta.url), 'utf8'),
    );
    const changed = applyLicenseOverrides(document, overrides);
    writeFileSync(path.join(source, NOTICE_FILENAME), changed ? `${JSON.stringify(document, null, 2)}\n` : report);
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
