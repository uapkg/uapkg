import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSupportedSpdxId } from '@cyclonedx/cyclonedx-library/SPDX';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { NOTICE_FILENAME } from '../../../packages/uapkg/build/Notices.ts';
import { archiveDirectory } from '../ReleaseArtifacts.ts';
import { verifyArchiveNotices, verifyNoticeDocument } from '../verifyReleaseNotices.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function document(
  specVersion = '1.5',
  component: { name: string; version: string; group?: string } = { name: '@uapkg/cli', version: '1.7.5' },
) {
  return {
    bomFormat: 'CycloneDX',
    specVersion,
    version: 1,
    metadata: {
      component: { type: 'application', licenses: [{ license: { id: 'MIT' } }], ...component },
    },
    components: [
      {
        type: 'library',
        name: 'example',
        version: '1.0.0',
        licenses: [{ expression: '(MIT OR Apache-2.0)' }],
      },
    ],
  };
}

async function archive(files: Record<string, string>) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'uapkg-archived-notice-test-'));
  directories.push(directory);
  const root = path.join(directory, 'contents');
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  const file = path.join(directory, 'release.tgz');
  await archiveDirectory(root, file);
  return file;
}

describe('verification of packaged SBOMs', () => {
  it('requires an SPDX ID and an upstream license link for every manual entry', () => {
    const entries: Record<string, { id: string; references: string[] }> = JSON.parse(
      readFileSync(new URL('../license-overrides.json', import.meta.url), 'utf8'),
    );
    for (const [purl, entry] of Object.entries(entries)) {
      expect(purl).toMatch(/^pkg:[a-z][\w.+-]*\/[^?#]+@[^@/?#]+(?:[?#].*)?$/);
      expect(isSupportedSpdxId(entry.id), purl).toBe(true);
      expect(entry.references.length, purl).toBeGreaterThan(0);
      for (const url of entry.references) expect(['https:', 'http:'], purl).toContain(new URL(url).protocol);
    }
  });

  it('reads the npm SBOM directly from its package-root archive member', async () => {
    const file = await archive({ ['package/' + NOTICE_FILENAME]: JSON.stringify(document()) });
    await expect(verifyArchiveNotices(file, 'npm', '1.7.5')).resolves.toBeUndefined();
    await expect(verifyArchiveNotices(file, 'node', '1.7.5', 'win-x64')).rejects.toThrow('one regular');
  });

  it('accepts generator-native subjects and validates the declared schema version', async () => {
    const npm = document('1.5', { name: 'cli', group: '@uapkg', version: '1.7.5' });
    await expect(verifyNoticeDocument(JSON.stringify(npm), 'npm', '1.7.5')).resolves.toBeUndefined();
    const launcher = document('1.6', { name: 'uapkg-launcher', version: '0.3.6' });
    await expect(verifyNoticeDocument(JSON.stringify(launcher), 'launcher', '0.3.6')).resolves.toBeUndefined();
    await expect(verifyNoticeDocument(JSON.stringify(document('99.0')), 'npm', '1.7.5')).rejects.toThrow('Unsupported');
  });

  it('rejects schema violations, incorrect product versions, and empty dependency inventories', async () => {
    const bom = document();
    await expect(verifyNoticeDocument(JSON.stringify(bom), 'npm', '1.7.6')).rejects.toThrow('1.7.6');
    await expect(verifyNoticeDocument(JSON.stringify(bom), 'launcher', '1.7.5')).rejects.toThrow('uapkg-launcher');
    bom.components[0]!.type = 'invalid-type';
    await expect(verifyNoticeDocument(JSON.stringify(bom), 'node', '1.7.5')).rejects.toThrow('Invalid CycloneDX');
    bom.components = [];
    await expect(verifyNoticeDocument(JSON.stringify(bom), 'node', '1.7.5')).rejects.toThrow('dependency components');
  });

  it('lists the product and nested dependencies with missing or placeholder licenses from a packed artifact', async () => {
    const bom = document();
    const child = (name: string, licenses?: object[]) => ({ type: 'library', name, version: '2.0.0', licenses });
    const contents = {
      ...bom,
      metadata: {
        component: { ...bom.metadata.component, licenses: [], components: [child('empty', [{ expression: '   ' }])] },
      },
      components: [
        ...bom.components,
        {
          ...child('parent', [{ license: { name: 'Example Company Commercial License' } }]),
          components: [
            { ...child('missing'), group: '@scope' },
            child('unknown', [{ license: { name: 'unknown' } }]),
            child('undetermined', [{ expression: 'NOASSERTION' }]),
            child('none', [{ expression: 'NONE' }]),
            child('unlicensed', [{ license: { name: 'UNLICENSED' } }]),
          ],
        },
      ],
    };
    const file = await archive({ ['package/' + NOTICE_FILENAME]: JSON.stringify(contents) });
    await expect(verifyArchiveNotices(file, 'npm', '1.7.5')).rejects.toThrow(
      'Missing license declarations: @uapkg/cli@1.7.5, empty@2.0.0, @scope/missing@2.0.0, unknown@2.0.0, undetermined@2.0.0, none@2.0.0, unlicensed@2.0.0.',
    );
  });

  it('accepts an upstream SPDX expression, a genuine named license and a sourced override', async () => {
    const bom = document();
    const contents = {
      ...bom,
      components: [
        ...bom.components,
        { type: 'library', name: 'vendor', version: '1', licenses: [{ license: { name: 'Vendor SDK License' } }] },
        {
          type: 'library',
          name: '@amplication/csharp-ast',
          version: '0.1.0',
          licenses: [
            { license: { id: 'Apache-2.0', url: 'https://github.com/amplication/ast-types/blob/main/LICENSE' } },
          ],
        },
      ],
    };
    await expect(verifyNoticeDocument(JSON.stringify(contents), 'npm', '1.7.5')).resolves.toBeUndefined();
  });

  it('checks the archived native engine descriptor against the requested format and target', async () => {
    const file = await archive({
      [NOTICE_FILENAME]: JSON.stringify(document()),
      'engine.json': JSON.stringify({ kind: 'sea', platform: 'linux-x64', version: '1.7.5' }),
    });
    await expect(verifyArchiveNotices(file, 'sea', '1.7.5', 'linux-x64')).resolves.toBeUndefined();
    await expect(verifyArchiveNotices(file, 'node', '1.7.5', 'linux-x64')).rejects.toThrow('node engine');
    await expect(verifyArchiveNotices(file, 'sea', '1.7.5', 'win-x64')).rejects.toThrow('win-x64');
  });

  it('rejects a second launcher archive member before executing the binary', async () => {
    const file = await archive({ uapkg: 'placeholder', [NOTICE_FILENAME]: '{}' });
    await expect(verifyArchiveNotices(file, 'launcher', '0.3.6', 'linux-x64')).rejects.toThrow('only uapkg');
  });
});
