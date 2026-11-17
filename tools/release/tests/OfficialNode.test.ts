import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  authenticatedArchiveHash,
  NODE_RELEASE_KEYRING_REVISION,
  NODE_RELEASE_KEYRING_SHA256,
  officialNodeIdentity,
  readOfficialNodeProvenance,
  verifyOfficialNodeRuntime,
} from '../OfficialNode.ts';

const temporary: string[] = [];
const originalProvenance = process.env.UAPKG_NODE_PROVENANCE;
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (originalProvenance === undefined) delete process.env.UAPKG_NODE_PROVENANCE;
  else process.env.UAPKG_NODE_PROVENANCE = originalProvenance;
});

describe('official Node runtime provenance', () => {
  it('selects only exact supported official archives, preserving upstream win-* names', () => {
    expect(officialNodeIdentity('26.13.1', 'linux-x64-musl').url).toBe(
      'https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-x64-musl.tar.xz',
    );
    expect(officialNodeIdentity('26.13.1', 'win-arm64').archive).toBe('node-v26.13.1-win-arm64.zip');
    for (const platform of ['linux-arm64-musl', 'win32-x64', '../linux-x64', 'linux-ppc64le'])
      expect(() => officialNodeIdentity('26.13.1', platform)).toThrow('supported distribution');
    expect(() => officialNodeIdentity('latest', 'linux-x64-musl')).toThrow('exact stable version');
  });

  it('does not substitute a GNU runtime when the authenticated musl archive is missing or duplicated', () => {
    const hash = 'a'.repeat(64);
    const archive = officialNodeIdentity('26.13.1', 'linux-x64-musl').archive;
    expect(authenticatedArchiveHash(`${hash}  ${archive}\n`, archive)).toBe(hash);
    expect(() => authenticatedArchiveHash(`${hash}  node-v26.13.1-linux-x64.tar.xz\n`, archive)).toThrow(
      'No runtime fallback',
    );
    expect(() => authenticatedArchiveHash(`${hash}  ${archive}\n${hash}  ${archive}\n`, archive)).toThrow(
      'exactly one',
    );
  });

  it('binds packaging to the pinned executable bytes and platform, rejecting forged evidence fields', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'uapkg-node-provenance-test-'));
    temporary.push(root);
    const file = path.join(root, 'node-provenance.json');
    const version = readFileSync(path.resolve(import.meta.dirname, '../../../.node-version'), 'utf8').trim();
    const platform = process.platform === 'win32' ? `win-${process.arch}` : `${process.platform}-${process.arch}`;
    const identity = officialNodeIdentity(version, platform);
    const evidence = {
      schemaVersion: 1,
      version,
      platform,
      archive: identity.archive,
      url: identity.url,
      sha256: 'a'.repeat(64),
      executableSha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
      checksumSignatureSha256: 'b'.repeat(64),
      keyringRevision: NODE_RELEASE_KEYRING_REVISION,
      keyringSha256: NODE_RELEASE_KEYRING_SHA256,
    };
    writeFileSync(file, JSON.stringify(evidence));
    process.env.UAPKG_NODE_PROVENANCE = file;
    expect(verifyOfficialNodeRuntime(platform)).toEqual(evidence);
    expect(() => verifyOfficialNodeRuntime('linux-x64-musl')).toThrow('differs');
    writeFileSync(file, JSON.stringify({ ...evidence, executableSha256: 'c'.repeat(64) }));
    expect(() => verifyOfficialNodeRuntime(platform)).toThrow('executing Node');
    for (const change of [
      { version: '26.0.0' },
      { url: 'https://unofficial-builds.nodejs.org/runtime.tar.xz' },
      { keyringSha256: 'd'.repeat(64) },
    ]) {
      writeFileSync(file, JSON.stringify({ ...evidence, ...change }));
      expect(() => readOfficialNodeProvenance(file)).toThrow('pinned release');
    }
    delete process.env.UAPKG_NODE_PROVENANCE;
    expect(() => verifyOfficialNodeRuntime(platform)).toThrow('require verified official');
  });
});
