import { createHash } from 'node:crypto';

/** Match the codeload archive to the Git objects listed by GitHub for this revision. */
export class ReleaseKeyTree {
  private readonly blobs = new Map<string, string>();

  constructor(response: Buffer) {
    const listing = JSON.parse(response.toString('utf8'));
    if (listing?.truncated !== false || !Array.isArray(listing.tree)) {
      throw new Error('Incomplete Git tree for the official Node release keys.');
    }
    for (const entry of listing.tree) {
      const path = entry?.path;
      if (typeof path !== 'string' || (path !== 'README.md' && !/^keys\/[^/]+\.asc$/.test(path))) continue;
      if (
        entry.type !== 'blob' ||
        !['100644', '100755'].includes(entry.mode) ||
        typeof entry.sha !== 'string' ||
        !/^[a-f0-9]{40}$/.test(entry.sha) ||
        this.blobs.has(path)
      ) {
        throw new Error('Invalid Git blob in the official Node release keys: ' + path);
      }
      this.blobs.set(path, entry.sha);
    }
  }

  verify(path: string, bytes: Buffer): void {
    const id = createHash('sha1')
      .update('blob ' + bytes.length + '\0')
      .update(bytes)
      .digest('hex');
    if (this.blobs.get(path) !== id)
      throw new Error('Node release key archive differs from the official Git tree: ' + path);
  }
}
