import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { verifyReleasePayloads } from '../publishRelease.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'uapkg-release-test-'));
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
  const catalog = { schemaVersion: 1, cliVersion: '2.0.0', launcherVersion: '1.0.0', artifacts };
  const save = () => writeFileSync(path.join(directory, 'release.json'), JSON.stringify(catalog));
  save();
  return { directory, catalog, save };
}

describe('release publication preflight', () => {
  it('accepts a complete, verified six-platform release', () => {
    const { directory } = fixture();
    expect(verifyReleasePayloads(directory).artifacts).toHaveLength(18);
  });
  it('rejects missing or duplicate targets', () => {
    const { directory, catalog, save } = fixture();
    catalog.artifacts.pop();
    save();
    expect(() => verifyReleasePayloads(directory)).toThrow('missing required artifacts');
    catalog.artifacts.push(catalog.artifacts[0]!);
    save();
    expect(() => verifyReleasePayloads(directory)).toThrow('duplicate release artifact');
  });
  it('rejects modified archives before any publication', () => {
    const { directory, catalog } = fixture();
    writeFileSync(path.join(directory, catalog.artifacts[0]!.fileName), 'modified payload');
    expect(() => verifyReleasePayloads(directory)).toThrow('mismatch');
  });
  it('rejects filenames that escape the release directory', () => {
    const { directory, catalog, save } = fixture();
    catalog.artifacts[0]!.fileName = '../outside.tar.gz';
    save();
    expect(() => verifyReleasePayloads(directory)).toThrow('archive basenames');
  });
});
