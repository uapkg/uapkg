import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { PLATFORMS, artifactName, inspectArtifact, type ReleaseProduct } from '../ReleaseArtifacts.ts';
import { verifyReleasePayloads, writeChecksums } from '../publishRelease.ts';
import { parseChecksums } from '../ReleaseContract.ts';
import { readFileSync } from 'node:fs';
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
export function fixture(product: ReleaseProduct = 'cli') {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'uapkg-release-test-'));
  directories.push(directory);
  const version = product === 'cli' ? '1.6.0' : '0.2.0';
  const artifacts = PLATFORMS.map((platform) => {
    const file = path.join(directory, artifactName(product, version, platform));
    writeFileSync(file, `verified ${platform} payload`);
    return inspectArtifact(file, platform);
  });
  const build = { schemaVersion: 1, product, version, artifacts };
  const save = () => writeFileSync(path.join(directory, 'build.json'), JSON.stringify(build));
  save();
  return { directory, build, save };
}
describe('independent native publication preflight', () => {
  it.each(['cli', 'launcher'] as const)('accepts a complete seven-platform %s release', (product) => {
    const { directory, build } = fixture(product);
    expect(writeChecksums(directory).artifacts).toHaveLength(7);
    expect(
      parseChecksums(readFileSync(path.join(directory, 'SHASUMS256.txt'), 'utf8'), product, build.version, PLATFORMS),
    ).toHaveLength(7);
  });
  it('rejects missing or duplicate targets', () => {
    const { directory, build, save } = fixture();
    build.artifacts.pop();
    save();
    expect(() => verifyReleasePayloads(directory)).toThrow('missing required platforms');
    build.artifacts.push(build.artifacts[0]!);
    save();
    expect(() => verifyReleasePayloads(directory)).toThrow('duplicate');
  });
  it('rejects modified archives', () => {
    const { directory, build } = fixture();
    writeFileSync(path.join(directory, build.artifacts[0]!.fileName), 'modified');
    expect(() => verifyReleasePayloads(directory)).toThrow('mismatch');
  });
  it('rejects mismatched identities and path escapes', () => {
    const { directory, build, save } = fixture();
    build.artifacts[0]!.fileName = '../outside.tar.gz';
    save();
    expect(() => verifyReleasePayloads(directory)).toThrow('Noncanonical');
  });
});
