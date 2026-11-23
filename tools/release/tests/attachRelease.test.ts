import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  attachReleaseAssets,
  createAttachmentAdapter,
  verifyPublishedRelease,
  type AttachmentAdapter,
} from '../attachRelease.ts';
import { artifactName, PLATFORMS, releaseTag, type ReleaseProduct } from '../ReleaseContract.ts';
import { inspectArtifact } from '../ReleaseArtifacts.ts';
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function temporary() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'uapkg-attachment-test-'));
  directories.push(directory);
  return directory;
}
function fixture(product: ReleaseProduct = 'cli') {
  const directory = temporary();
  const version = '2.0.0-beta.1';
  const artifacts = PLATFORMS.map((platform) => {
    const file = path.join(directory, artifactName(product, version, platform));
    writeFileSync(file, `verified ${platform} payload`);
    return inspectArtifact(file, platform);
  });
  writeFileSync(path.join(directory, 'build.json'), JSON.stringify({ schemaVersion: 1, product, version, artifacts }));
  const remote = new Map<string, Buffer>();
  const uploads: string[] = [];
  const release = () => ({
    tagName: releaseTag(product, version),
    isDraft: false,
    publishedAt: '2026-11-01T12:34:56Z',
    assets: [...remote.keys()].map((name) => ({ name })),
  });
  const adapter: AttachmentAdapter = {
    getRelease: vi.fn(release),
    createRelease: vi.fn(release),
    download: vi.fn((_tag, name, output) => writeFileSync(path.join(output, name), remote.get(name)!)),
    verifySignature: vi.fn(),
    sign: vi.fn(() => writeFileSync(path.join(directory, 'SHASUMS256.txt.minisig'), 'new valid signature')),
    upload: vi.fn((_tag, file) => {
      const name = path.basename(file);
      if (remote.has(name)) throw new Error('Already exists');
      uploads.push(name);
      remote.set(name, readFileSync(file));
    }),
  };
  return { directory, version, product, artifacts, remote, uploads, adapter };
}
describe('immutable independent release attachment', () => {
  it.each(['cli', 'launcher'] as const)('publishes %s without npm and retries without replacements', (product) => {
    const test = fixture(product);
    // Release staging may contain reports. Only the platform archives and signed checksums are public assets.
    writeFileSync(path.join(test.directory, 'THIRD-PARTY-NOTICES.txt'), '{}');
    writeFileSync(path.join(test.directory, 'sbom.cdx.json'), '{}');
    const first = test.artifacts[0]!.fileName;
    test.remote.set(first, readFileSync(path.join(test.directory, first)));
    expect(attachReleaseAssets(test.directory, test.adapter)).toHaveLength(8);
    expect(test.adapter.getRelease).toHaveBeenCalledWith(releaseTag(product, test.version));
    expect(test.uploads.slice(-2)).toEqual(['SHASUMS256.txt', 'SHASUMS256.txt.minisig']);
    expect([...test.remote.keys()].sort()).toEqual(
      [...test.artifacts.map((artifact) => artifact.fileName), 'SHASUMS256.txt', 'SHASUMS256.txt.minisig'].sort(),
    );
    expect(attachReleaseAssets(test.directory, test.adapter)).toEqual([]);
    expect(test.adapter.sign).toHaveBeenCalledTimes(1);
    const entry = verifyPublishedRelease(temporary(), product, test.version, test.adapter);
    expect(entry.publishedAt).toBe('2026-11-01T12:34:56Z');
    expect(entry.files).toEqual(PLATFORMS);
  });
  it('checks every existing archive before any signing/upload', () => {
    const test = fixture();
    test.remote.set(test.artifacts.at(-1)!.fileName, Buffer.from('different build'));
    expect(() => attachReleaseAssets(test.directory, test.adapter)).toThrow('immutable');
    expect(test.adapter.sign).not.toHaveBeenCalled();
    expect(test.uploads).toEqual([]);
  });
  it('retains the original signature bytes on retries', () => {
    const test = fixture();
    test.remote.set('SHASUMS256.txt.minisig', Buffer.from('original signature'));
    attachReleaseAssets(test.directory, test.adapter);
    expect(test.adapter.sign).not.toHaveBeenCalled();
    expect(readFileSync(path.join(test.directory, 'SHASUMS256.txt.minisig'), 'utf8')).toBe('original signature');
  });
  it('does not accept partial, altered or badly signed remote releases as catalog input', () => {
    const test = fixture();
    expect(() => verifyPublishedRelease(temporary(), test.product, test.version, test.adapter)).toThrow(
      'missing required assets',
    );
    attachReleaseAssets(test.directory, test.adapter);
    test.remote.set(test.artifacts[0]!.fileName, Buffer.from('altered remote archive'));
    expect(() => verifyPublishedRelease(temporary(), test.product, test.version, test.adapter)).toThrow(
      'checksum mismatch',
    );
    test.adapter.verifySignature = () => {
      throw new Error('Invalid signature');
    };
    expect(() => verifyPublishedRelease(temporary(), test.product, test.version, test.adapter)).toThrow(
      'Invalid signature',
    );
  });
  it('never clobbers and does not translate authentication failures to missing releases', () => {
    const execute = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    const adapter = createAttachmentAdapter('uapkg/uapkg', 'public-key', 'a'.repeat(40), execute);
    adapter.upload('uapkg-launcher@0.2.0', 'archive with spaces.tar.gz');
    expect(execute).toHaveBeenCalledWith('gh', [
      'release',
      'upload',
      'uapkg-launcher@0.2.0',
      'archive with spaces.tar.gz',
      '--repo',
      'uapkg/uapkg',
    ]);
    execute.mockReturnValue({ status: 1, stdout: '', stderr: 'HTTP 404' });
    expect(adapter.getRelease('uapkg-launcher@0.2.0')).toBeNull();
    execute.mockReturnValue({ status: 1, stdout: '', stderr: 'HTTP 403' });
    expect(() => adapter.getRelease('uapkg-launcher@0.2.0')).toThrow('Could not read release');
  });
});
