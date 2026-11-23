import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vite-plus/test';
import {
  applyLicenseOverrides,
  hasDeclaredLicense,
  NOTICE_FILENAME,
  npmCliPath,
  writeNpmSbom,
} from '../../build/Notices.ts';

it('fills only unresolved exact-version matches, retaining upstream declarations and references', () => {
  const purl = 'pkg:npm/test@1.0.0';
  const first = 'https://example.com/LICENSE';
  const second = 'https://example.com/NOTICE';
  const referenced = {
    purl,
    licenses: [{ license: { name: ' unknown ' } }],
    externalReferences: [
      { type: 'vcs', url: first },
      { type: 'license', url: second },
    ],
  };
  const named = { purl, licenses: [{ license: { name: 'Upstream commercial license' } }] };
  const expression = { purl, licenses: [{ expression: 'MIT OR Apache-2.0' }] };
  const newVersion = { purl: 'pkg:npm/test@1.1.0' };
  const report = { metadata: { component: named }, components: [expression, { components: [referenced, newVersion] }] };
  const overrides = { [purl]: { id: 'MIT', references: [first, second, first] } };
  expect(applyLicenseOverrides(report, overrides)).toBe(true);
  expect(referenced.licenses).toEqual([{ license: { id: 'MIT', url: first } }]);
  expect(referenced.externalReferences).toEqual([
    { type: 'vcs', url: first },
    { type: 'license', url: second },
    { type: 'license', url: first },
  ]);
  expect(named.licenses).toEqual([{ license: { name: 'Upstream commercial license' } }]);
  expect(expression.licenses).toEqual([{ expression: 'MIT OR Apache-2.0' }]);
  expect(newVersion).toEqual({ purl: 'pkg:npm/test@1.1.0' });
  expect(applyLicenseOverrides(report, overrides)).toBe(false);
});

it('treats missing license markers consistently across CycloneDX fields', () => {
  expect(hasDeclaredLicense({})).toBe(false);
  for (const value of [
    '  ',
    ' unknown ',
    'NoAssertion',
    'NONE',
    'unlicensed',
    'n/a',
    'UNSPECIFIED',
    'SEE LICENSE IN LICENSE.txt',
  ]) {
    expect(
      hasDeclaredLicense({
        licenses: [{ expression: value }, { license: { name: value } }, { license: { id: value } }],
      }),
    ).toBe(false);
  }
  expect(hasDeclaredLicense({ licenses: [{ license: { name: 'UNKNOWN' } }, { license: { id: 'MIT' } }] })).toBe(true);
});

it('includes the reviewed license in npm’s lockfile and installed-tree SBOMs', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'uapkg-sbom-test-'));
  try {
    const manifest = {
      name: '@uapkg/cli',
      version: '1.7.5',
      license: 'MIT',
      dependencies: { '@amplication/ast-types': '0.0.2' },
      optionalDependencies: { 'other-platform': '2.0.0' },
    };
    const installed = { name: '@amplication/ast-types', version: '0.0.2' };
    const lock = {
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      packages: {
        '': manifest,
        'node_modules/@amplication/ast-types': installed,
        'node_modules/other-platform': { version: '2.0.0', license: 'MIT', optional: true },
      },
    };
    mkdirSync(path.join(root, 'dist'));
    writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
    writeFileSync(path.join(root, 'dist/runtime-lock.json'), JSON.stringify(lock));
    const npmVersion = JSON.parse(
      readFileSync(path.resolve(path.dirname(npmCliPath()), '../package.json'), 'utf8'),
    ).version;
    const readReport = () => JSON.parse(readFileSync(path.join(root, NOTICE_FILENAME), 'utf8'));
    const expectReviewedLicense = (components: { purl: string }[]) => {
      const source = 'https://github.com/amplication/ast-types/blob/3e36e05bb6b96f14df1153cb6fb4ca8351f6ba23/LICENSE';
      expect(components.find((item) => item.purl === 'pkg:npm/%40amplication/ast-types@0.0.2')).toMatchObject({
        licenses: [{ license: { id: 'Apache-2.0', url: source } }],
        externalReferences: expect.arrayContaining([{ type: 'license', url: source }]),
      });
    };

    writeNpmSbom(root, 'lockfile', npmVersion);
    const locked = readReport();
    expect(locked.metadata.component).toMatchObject({
      'bom-ref': `${manifest.name}@${manifest.version}`,
      version: manifest.version,
      type: 'application',
    });
    expect(locked.metadata.tools).toContainEqual({ vendor: 'npm', name: 'cli', version: npmVersion });
    expectReviewedLicense(locked.components);
    expect(locked.components).toHaveLength(2);
    expect(locked.components).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'other-platform' })]));

    mkdirSync(path.join(root, 'node_modules/@amplication/ast-types'), { recursive: true });
    writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
    writeFileSync(path.join(root, 'node_modules/@amplication/ast-types/package.json'), JSON.stringify(installed));
    writeNpmSbom(root, 'installed', npmVersion);
    const actual = readReport();
    expectReviewedLicense(actual.components);
    expect(actual.components).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
