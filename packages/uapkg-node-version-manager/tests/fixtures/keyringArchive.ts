import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { create } from 'tar';
import { NODE_RELEASE_KEYS_REVISION } from '../../src/NodeReleaseKeys.ts';

export interface KeyringFixtureKey {
  fingerprint: string;
  armored: string;
  retired?: boolean;
}

interface BlobEntry {
  path: string;
  size: number;
  mode: '100644';
  type: 'blob';
  sha: string;
}

function gitBlob(path: string, content: string): BlobEntry {
  const size = Buffer.byteLength(content);
  return {
    path,
    size,
    mode: '100644',
    type: 'blob',
    sha: createHash('sha1')
      .update('blob ' + size + '\0')
      .update(content)
      .digest('hex'),
  };
}

interface KeyringFixtureSnapshot {
  archive: Uint8Array;
  tree: BlobEntry[];
}

/** A small archive with the same layout as a commit tarball from nodejs/release-keys. */
export async function keyringArchive(
  root: string,
  revision: string,
  keys: readonly KeyringFixtureKey[],
): Promise<KeyringFixtureSnapshot> {
  const stage = await mkdtemp(join(root, 'repository-'));
  try {
    const name = 'release-keys-' + revision;
    const directory = join(stage, name);
    await mkdir(join(directory, 'keys'), { recursive: true });
    const files = new Map<string, string>();
    const readme = ['# Node.js Release Keys', ''];
    for (const [section, retired] of [
      ['Active releasers keys', false],
      ['Retired keys', true],
    ] as const) {
      readme.push('<!-- ' + section + ' -->');
      for (const key of keys.filter((key) => Boolean(key.retired) === retired)) {
        const fingerprint = key.fingerprint;
        readme.push(
          '* **Releaser** <releaser@example.org>',
          '  [`' + fingerprint + '`](./keys/' + fingerprint + '.asc)',
        );
        files.set('keys/' + fingerprint + '.asc', key.armored);
      }
      readme.push('<!-- /' + section + ' -->', '');
    }
    files.set('README.md', readme.join('\n'));
    files.set('keys.list', keys.map((key) => key.fingerprint).join('\n') + '\n');
    const tree: BlobEntry[] = [];
    for (const [path, contents] of files) {
      await writeFile(join(directory, path), contents);
      tree.push(gitBlob(path, contents));
    }
    const tarball = join(stage, 'keys.tgz');
    await create({ cwd: stage, gzip: true, file: tarball, portable: true }, [name]);
    return { archive: await readFile(tarball), tree };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Mock only the official key repository. Callers can supply a separate handler for nodejs.org. */
export function mockKeyringRepository() {
  const api = 'https://api.github.com/repos/nodejs/release-keys';
  const snapshots = new Map<string, KeyringFixtureSnapshot>();
  const history = [NODE_RELEASE_KEYS_REVISION as string];
  let current = history[0]!;
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === api + '/git/ref/heads/main') {
      return Response.json({ ref: 'refs/heads/main', object: { sha: current, type: 'commit' } });
    }
    for (const [index, head] of history.entries()) {
      const snapshot = snapshots.get(head);
      if (url === 'https://codeload.github.com/nodejs/release-keys/tar.gz/' + head && snapshot) {
        return new Response(new Uint8Array(snapshot.archive));
      }
      if (url === api + '/git/trees/' + head + '?recursive=1' && snapshot) {
        return Response.json({ truncated: false, tree: snapshot.tree });
      }
      for (const [prior, base] of history.entries()) {
        if (url !== api + '/compare/' + base + '...' + head + '?per_page=1') continue;
        return Response.json({
          status: prior === index ? 'identical' : prior < index ? 'ahead' : 'behind',
          ahead_by: Math.max(0, index - prior),
          behind_by: Math.max(0, prior - index),
          base_commit: { sha: base },
          merge_base_commit: { sha: prior <= index ? base : head },
        });
      }
    }
    throw new Error('Unexpected key repository request: ' + url);
  };
  return {
    fetch,
    publish(revision: string, snapshot: KeyringFixtureSnapshot | Uint8Array) {
      if (!history.includes(revision)) history.push(revision);
      current = revision;
      snapshots.set(revision, snapshot instanceof Uint8Array ? { archive: snapshot, tree: [] } : snapshot);
    },
  };
}
