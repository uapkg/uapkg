import { gunzipSync } from 'node:zlib';
import { Parser } from 'tar';
import { enums, PacketList, readSignature, type PublicKey, type SignaturePacket, type Subkey } from 'openpgp';
import { readNodeReleaseKey } from '#node-version-manager/NodeChecksum.ts';
import type { ReleaseKeyTree } from '#node-version-manager/ReleaseKeyTree.ts';

const fingerprintPattern = /^(?:[0-9A-F]{40}|[0-9A-F]{64})$/;
const keyEntry = /^  \[`([0-9A-F]+)`\]\(\.\/keys\/([0-9A-F]+)\.asc\)$/;
const sections = ['Active releasers keys', 'Retired keys'];

// Node's generate-gpg-dir.sh builds the full release keyring from these two
// README sections. A leftover .asc file in the repository grants no authority.
function authorizedFingerprints(readme: string): Set<string> {
  const authorized = new Set<string>();
  const lines = readme.replaceAll('\r\n', '\n').split('\n');
  for (const section of sections) {
    const open = `<!-- ${section} -->`;
    const close = `<!-- /${section} -->`;
    const start = lines.indexOf(open);
    const end = lines.indexOf(close);
    if (start < 0 || end <= start || start !== lines.lastIndexOf(open) || end !== lines.lastIndexOf(close)) {
      throw new Error('Invalid Node release key inventory section: ' + section);
    }
    for (const line of lines.slice(start + 1, end)) {
      if (!line.trim() || line.startsWith('* ')) continue;
      const match = keyEntry.exec(line);
      if (!match || match[1] !== match[2] || !fingerprintPattern.test(match[1]!) || authorized.has(match[1]!)) {
        throw new Error('Invalid or duplicate Node release key inventory entry.');
      }
      authorized.add(match[1]!);
    }
  }
  // Empty sections (including a full withdrawal) are valid if the document
  // carries the explicit authority boundaries. No keys means no valid signer.
  return authorized;
}

/** Read a commit-addressed codeload archive in memory. No archive paths are extracted. */
export async function readReleaseKeyArchive(
  archive: Buffer,
  revision: string,
  tree: ReleaseKeyTree,
): Promise<Record<string, string>> {
  const unpacked = gunzipSync(archive, { maxOutputLength: 16 * 1024 * 1024 });
  if (unpacked.subarray(257, 262).toString('ascii') !== 'ustar')
    throw new Error('Invalid Node release key tar archive.');
  const root = 'release-keys-' + revision + '/';
  const files = new Map<string, Buffer>();
  const seen = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({ strict: true });
    parser.on('error', reject);
    parser.on('end', resolve);
    parser.on('entry', (entry) => {
      const relative = entry.path.startsWith(root) ? entry.path.slice(root.length) : '';
      if (relative !== 'README.md' && !/^keys\/[^/]+\.asc$/.test(relative)) {
        entry.resume();
        return;
      }
      if (seen.has(relative) || entry.type !== 'File' || entry.size > 1024 * 1024) {
        reject(new Error('Invalid or duplicate file in Node release key inventory: ' + relative));
        entry.resume();
        return;
      }
      seen.add(relative);
      const chunks: Buffer[] = [];
      entry.on('data', (chunk: Buffer) => chunks.push(chunk));
      entry.on('end', () => files.set(relative, Buffer.concat(chunks)));
    });
    parser.end(unpacked);
  });

  const certs: Record<string, string> = {};
  const readme = files.get('README.md');
  if (!readme) throw new Error('Missing Node release key inventory in archive.');
  tree.verify('README.md', readme);
  for (const fingerprint of authorizedFingerprints(readme.toString('utf8'))) {
    const file = 'keys/' + fingerprint + '.asc';
    const cert = files.get(file);
    if (!cert) throw new Error('Missing public key in Node release key inventory: ' + fingerprint);
    tree.verify(file, cert);
    certs[fingerprint] = cert.toString('utf8');
  }
  return certs;
}

export interface ReleaseKeySnapshot {
  revision: string;
  certificates: Record<string, string>;
  // Keep signed revocations even if a later upstream export omits the
  // packet or temporarily removes the associated key from its inventory.
  revocations: Record<string, string[]>;
}

async function verifiesRevocation(
  key: PublicKey,
  subject: PublicKey | Subkey,
  signature: SignaturePacket,
): Promise<boolean> {
  const type = subject === key ? enums.signature.keyRevocation : enums.signature.subkeyRevocation;
  if (signature.signatureType !== type || !signature.issuerKeyID.equals(key.getKeyID()) || !signature.created)
    return false;
  const signedData = subject === key ? { key: key.keyPacket } : { key: key.keyPacket, bind: subject.keyPacket };
  try {
    // Authenticate this packet against its exact subject before remembering it.
    // OpenPGP evaluates its effective date/reason separately when checking a release.
    await signature.verify(key.keyPacket, type, signedData, signature.created);
    return true;
  } catch {
    return false;
  }
}

/** Add remembered revocations only. Trust in every primary key and binding still comes from the current inventory. */
export async function snapshotKeys(snapshot: ReleaseKeySnapshot): Promise<PublicKey[]> {
  const result: PublicKey[] = [];
  for (const [fingerprint, certificate] of Object.entries(snapshot.certificates)) {
    if (!fingerprintPattern.test(fingerprint)) throw new Error('Invalid Node release key fingerprint.');
    const key = await readNodeReleaseKey(Buffer.from(certificate), fingerprint);
    for (const subject of [key, ...key.subkeys]) {
      const name = fingerprint + '/' + subject.getFingerprint().toUpperCase();
      const current = new Map<string, SignaturePacket>();
      for (const signature of subject.revocationSignatures) {
        if (!(await verifiesRevocation(key, subject, signature))) continue;
        const packets = new PacketList<SignaturePacket>();
        packets.push(signature);
        current.set(Buffer.from(packets.write()).toString('base64'), signature);
      }
      for (const previous of snapshot.revocations[name] ?? []) {
        if (current.has(previous)) continue;
        const { packets } = await readSignature({ binarySignature: Buffer.from(previous, 'base64') });
        if (packets.length !== 1 || !(await verifiesRevocation(key, subject, packets[0]!))) {
          throw new Error('Invalid cached Node key revocation.');
        }
        current.set(previous, packets[0]!);
      }
      subject.revocationSignatures = [...current.values()];
      if (current.size) snapshot.revocations[name] = [...current.keys()];
    }
    result.push(key);
  }
  return result;
}
