import { describe, expect, it } from 'vite-plus/test';
import { ReleaseKeyTree } from '../src/ReleaseKeyTree.ts';

const readme = { path: 'README.md', mode: '100644', type: 'blob', sha: 'd670460b4b4aece5915caf5c68d12f560a9fe3e4' };
const listing = (entries: unknown[], truncated = false) => Buffer.from(JSON.stringify({ tree: entries, truncated }));

describe('commit-addressed release-key inventory', () => {
  it('requires the exact listed Git blob for each trust input', () => {
    const tree = new ReleaseKeyTree(listing([readme]));
    tree.verify('README.md', Buffer.from('test content\n'));
    expect(() => tree.verify('README.md', Buffer.from('test content\r\n'))).toThrow(
      'differs from the official Git tree',
    );
    expect(() => tree.verify('keys/unlisted.asc', Buffer.from('test content\n'))).toThrow(
      'differs from the official Git tree',
    );
  });

  it('rejects incomplete or ambiguous inventories and non-regular files', () => {
    expect(() => new ReleaseKeyTree(listing([], true))).toThrow('Incomplete Git tree');
    expect(() => new ReleaseKeyTree(listing([readme, readme]))).toThrow('Invalid Git blob');
    expect(() => new ReleaseKeyTree(listing([{ ...readme, mode: '120000' }]))).toThrow('Invalid Git blob');
  });
});
