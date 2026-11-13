import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  attachReleaseAssets,
  createAttachmentAdapter,
  waitForNpmPublication,
  type AttachmentAdapter,
} from '../attachRelease.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('npm publication visibility', () => {
  it('continues after transient missing-version responses without a real delay', async () => {
    const probe = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);
    const pause = vi.fn(async (_milliseconds: number) => {});
    const progress = vi.fn();
    await waitForNpmPublication('1.5.1', probe, { pause, progress });
    expect(probe.mock.calls).toEqual([['1.5.1'], ['1.5.1'], ['1.5.1']]);
    expect(pause.mock.calls).toEqual([[10_000], [10_000]]);
    expect(progress).toHaveBeenCalledTimes(2);
  });

  it('limits visibility checks to 31 attempts and five minutes of waiting', async () => {
    const probe = vi.fn(() => false);
    const pause = vi.fn(async (_milliseconds: number) => {});
    const progress = vi.fn();
    await expect(waitForNpmPublication('1.5.1', probe, { pause, progress })).rejects.toThrow(
      '@uapkg/cli@1.5.1 is still absent from https://registry.npmjs.org/ after 31 checks and five minutes of waiting',
    );
    expect(probe).toHaveBeenCalledTimes(31);
    expect(pause).toHaveBeenCalledTimes(30);
    expect(pause.mock.calls.every(([milliseconds]) => milliseconds === 10_000)).toBe(true);
    expect(progress).toHaveBeenCalledTimes(30);
  });

  it('fails immediately on an npm authentication error', async () => {
    const execute = vi.fn(() => ({ status: 1, stdout: '', stderr: 'npm error E401 authentication failed' }));
    const adapter = createAttachmentAdapter('uapkg/uapkg', 'public-key', execute);
    const pause = vi.fn(async (_milliseconds: number) => {});
    const progress = vi.fn();
    await expect(waitForNpmPublication('1.5.1', adapter.isPublished, { pause, progress })).rejects.toThrow(
      'E401 authentication failed',
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(pause).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });

  it('does not pause or report a wait for an already visible version', async () => {
    const probe = vi.fn(() => true);
    const pause = vi.fn(async (_milliseconds: number) => {});
    const progress = vi.fn();
    await waitForNpmPublication('1.5.1', probe, { pause, progress });
    expect(probe).toHaveBeenCalledOnce();
    expect(pause).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });
});

function fixture(version = '2.0.0') {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'uapkg-attachment-test-'));
  directories.push(directory);
  const contents = Buffer.from('verified payload');
  const artifacts = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'].flatMap(
    (platform) =>
      ['cli', 'launcher', 'bundle'].map((kind) => {
        const fileName = `${kind}-${platform}.tar.gz`;
        writeFileSync(path.join(directory, fileName), contents);
        return {
          kind,
          platform,
          fileName,
          sha256: createHash('sha256').update(contents).digest('hex'),
          size: contents.length,
        };
      }),
  );
  writeFileSync(
    path.join(directory, 'release.json'),
    JSON.stringify({ schemaVersion: 1, cliVersion: version, launcherVersion: '1.0.0', artifacts }),
  );
  const remote = new Map<string, Buffer>();
  const uploads: string[] = [];
  const adapter: AttachmentAdapter = {
    isPublished: vi.fn(() => true),
    getRelease: vi.fn((tag) => ({
      tagName: tag,
      isDraft: false,
      assets: [...remote.keys()].map((name) => ({ name })),
    })),
    download: vi.fn((_tag, name, output) => writeFileSync(path.join(output, name), remote.get(name)!)),
    verifySignature: vi.fn(),
    sign: vi.fn(() => writeFileSync(path.join(directory, 'release.json.minisig'), 'new valid signature')),
    upload: vi.fn((_tag, file) => {
      const name = path.basename(file);
      if (remote.has(name)) throw new Error('Already exists');
      uploads.push(name);
      remote.set(name, readFileSync(file));
    }),
  };
  return { directory, version, artifacts, remote, uploads, adapter };
}

describe('retry-safe release attachment', () => {
  it('resumes missing archives and publishes metadata last, with no second upload on retry', () => {
    const test = fixture('2.0.0-rc.1');
    const first = test.artifacts[0]!.fileName;
    test.remote.set(first, readFileSync(path.join(test.directory, first)));
    expect(attachReleaseAssets(test.directory, test.version, test.adapter)).toHaveLength(19);
    expect(test.adapter.getRelease).toHaveBeenCalledWith('@uapkg/cli@2.0.0-rc.1');
    expect(test.uploads).not.toContain(first);
    expect(test.uploads.slice(-2)).toEqual(['release.json', 'release.json.minisig']);
    expect(attachReleaseAssets(test.directory, test.version, test.adapter)).toEqual([]);
    expect(test.adapter.sign).toHaveBeenCalledTimes(1);
  });

  it('checks all existing bytes before signing or uploading', () => {
    const test = fixture();
    test.remote.set(test.artifacts.at(-1)!.fileName, Buffer.from('different executable build'));
    expect(() => attachReleaseAssets(test.directory, test.version, test.adapter)).toThrow('immutable');
    expect(test.adapter.sign).not.toHaveBeenCalled();
    expect(test.uploads).toEqual([]);
  });

  it('accepts an existing authenticated signature even when fresh signing would produce different bytes', () => {
    const test = fixture();
    test.remote.set('release.json.minisig', Buffer.from('valid signature with previous timestamp'));
    attachReleaseAssets(test.directory, test.version, test.adapter);
    expect(test.adapter.sign).not.toHaveBeenCalled();
    expect(test.adapter.verifySignature).toHaveBeenCalledOnce();
    expect(test.uploads).not.toContain('release.json.minisig');
  });

  it('rejects conflicting metadata or invalid signatures without any uploads', () => {
    const test = fixture();
    test.remote.set('release.json', Buffer.from('{}'));
    expect(() => attachReleaseAssets(test.directory, test.version, test.adapter)).toThrow('release.json');
    test.remote.clear();
    test.remote.set('release.json.minisig', Buffer.from('invalid'));
    test.adapter.verifySignature = () => {
      throw new Error('Invalid signature');
    };
    expect(() => attachReleaseAssets(test.directory, test.version, test.adapter)).toThrow('Invalid signature');
    expect(test.uploads).toEqual([]);
  });

  it('fails on an unpublished exact npm version before looking up or modifying a GitHub release', () => {
    const test = fixture();
    test.adapter.isPublished = () => false;
    expect(() => attachReleaseAssets(test.directory, test.version, test.adapter)).toThrow(
      '@uapkg/cli@2.0.0 is not published at https://registry.npmjs.org/. Complete npm publication',
    );
    expect(test.adapter.getRelease).not.toHaveBeenCalled();
    expect(test.adapter.download).not.toHaveBeenCalled();
    expect(test.adapter.sign).not.toHaveBeenCalled();
    expect(test.adapter.upload).not.toHaveBeenCalled();
  });

  it('rejects incorrect or draft release identities', () => {
    const test = fixture();
    test.adapter.getRelease = () => ({ tagName: '@uapkg/cli@1.0.0', isDraft: false, assets: [] });
    expect(() => attachReleaseAssets(test.directory, test.version, test.adapter)).toThrow('Expected the published');
    test.adapter.getRelease = (tagName) => ({ tagName, isDraft: true, assets: [] });
    expect(() => attachReleaseAssets(test.directory, test.version, test.adapter)).toThrow('Expected the published');
    expect(test.uploads).toEqual([]);
  });

  it('uses exact argument arrays, fixed npm registry, and uploads without clobber', () => {
    const execute = vi.fn((_command: string, args: string[]) => ({
      status: 0,
      stdout:
        args.includes('view') && args[0] !== 'release'
          ? '"2.0.0-rc.1"'
          : '{"tagName":"@uapkg/cli@2.0.0-rc.1","isDraft":false,"assets":[]}',
      stderr: '',
    }));
    const adapter = createAttachmentAdapter('uapkg/uapkg', 'public-key', execute);
    expect(adapter.isPublished('2.0.0-rc.1')).toBe(true);
    expect(execute.mock.calls[0]![1]).toContain('--registry=https://registry.npmjs.org/');
    expect(execute.mock.calls[0]![1]).toEqual(
      expect.arrayContaining(['--prefer-online', '--fetch-retries=0', '--fetch-timeout=10000']),
    );
    const tag = '@uapkg/cli@2.0.0-rc.1';
    expect(adapter.getRelease(tag).tagName).toBe(tag);
    adapter.download(tag, 'release.json', 'directory with spaces');
    adapter.verifySignature('release.json', 'old signature.minisig');
    adapter.upload(tag, 'archive with spaces.tar.gz');
    expect(execute).toHaveBeenLastCalledWith('gh', [
      'release',
      'upload',
      tag,
      'archive with spaces.tar.gz',
      '--repo',
      'uapkg/uapkg',
    ]);
    expect(execute.mock.calls.flatMap((call) => call[1])).not.toContain('--clobber');
  });

  it('only treats npm E404 as an unpublished version', () => {
    const execute = vi.fn(() => ({ status: 1, stdout: '', stderr: 'npm error E404 version not found' }));
    const adapter = createAttachmentAdapter('uapkg/uapkg', 'public-key', execute);
    expect(adapter.isPublished('2.0.0')).toBe(false);
    execute.mockReturnValue({ status: 1, stdout: '', stderr: 'npm error E401 authentication failed' });
    expect(() => adapter.isPublished('2.0.0')).toThrow('Could not confirm npm publication');
  });
});
