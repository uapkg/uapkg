import {
  createCleartextMessage,
  enums,
  generateKey,
  readPrivateKey,
  SecretKeyPacket,
  sign,
  type PrivateKey,
} from 'openpgp';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { snapshotKeys, type ReleaseKeySnapshot } from '../src/ReleaseKeyArchive.ts';
import {
  authenticateNodeChecksum,
  NodeChecksumSignatureError,
  readNodeReleaseKey,
  UnrecognizedNodeSignerError,
} from '../src/NodeChecksum.ts';

const target = { version: '24.1.0', asset: 'win-x64/node.exe' };
const digest = 'a'.repeat(64);
const created = new Date('2024-01-01T00:00:00Z');
const signedAt = new Date('2024-01-02T00:00:00Z');
const rotatedAt = new Date('2024-01-03T00:00:00Z');
const afterRotation = new Date('2024-01-04T00:00:00Z');

async function releaser(name: string, keyExpirationTime?: number) {
  return (
    await generateKey({
      type: 'ecc',
      curve: 'curve25519Legacy',
      userIDs: [{ name }],
      date: created,
      keyExpirationTime,
      subkeys: [{ sign: true }],
      format: 'object',
    })
  ).privateKey;
}

async function signChecksum(key: PrivateKey, date: Date, subkey = key.getSubkeys()[0]!) {
  return sign({
    message: await createCleartextMessage({
      text: digest + '  ' + target.asset + '\n' + 'e'.repeat(64) + '  node-v' + target.version + '.tar.gz',
    }),
    signingKeys: key,
    signingKeyIDs: subkey.getKeyID(),
    date,
  });
}

describe('the release certificate used for Node checksums', () => {
  let original: PrivateKey;
  let replacement: PrivateKey;
  let checksums: string;
  beforeAll(async () => {
    [original, replacement] = await Promise.all([releaser('Original'), releaser('Replacement')]);
    checksums = await signChecksum(original, signedAt);
  });

  it('accepts exactly the expected public certificate', async () => {
    const bytes = Buffer.from(original.toPublic().armor());
    const fp = original.getFingerprint();
    expect((await readNodeReleaseKey(bytes, fp)).getFingerprint()).toBe(fp);
    await expect(readNodeReleaseKey(bytes, replacement.getFingerprint())).rejects.toThrow('fingerprint mismatch');
    await expect(readNodeReleaseKey(Buffer.from(original.armor()), fp)).rejects.toThrow('single armored public');
    await expect(readNodeReleaseKey(Buffer.concat([bytes, bytes]), fp)).rejects.toThrow('single armored public');
  });

  it('uses added and removed releaser keys from the supplied snapshot', async () => {
    const newChecksums = await signChecksum(replacement, afterRotation);
    await expect(authenticateNodeChecksum(newChecksums, target, [original.toPublic()])).rejects.toThrow(
      UnrecognizedNodeSignerError,
    );
    expect(await authenticateNodeChecksum(newChecksums, target, [replacement.toPublic()])).toBe(digest);
    await expect(authenticateNodeChecksum(checksums, target, [replacement.toPublic()])).rejects.toThrow(
      UnrecognizedNodeSignerError,
    );
  });

  it('accepts a newly bound signing subkey only with the refreshed certificate', async () => {
    const rotated = await original.addSubkey({ sign: true, date: rotatedAt });
    const added = rotated.getSubkeys().find((key) => !original.getSubkeys(key.getKeyID()).length)!;
    const newChecksums = await signChecksum(rotated, afterRotation, added);
    await expect(authenticateNodeChecksum(newChecksums, target, [original.toPublic()])).rejects.toThrow(
      UnrecognizedNodeSignerError,
    );
    expect(await authenticateNodeChecksum(newChecksums, target, [rotated.toPublic()])).toBe(digest);
  });

  it('rejects an existing release upon learning of a compromised primary key', async () => {
    expect(await authenticateNodeChecksum(checksums, target, [original.toPublic()])).toBe(digest);
    const revoked = await original.revoke({ flag: enums.reasonForRevocation.keyCompromised }, rotatedAt);
    await expect(authenticateNodeChecksum(checksums, target, [revoked.toPublic()])).rejects.toThrow(
      NodeChecksumSignatureError,
    );
  });

  it('rejects an existing release upon learning of a compromised signing subkey', async () => {
    const local = await readPrivateKey({ armoredKey: original.armor() });
    const subkey = local.getSubkeys()[0]!;
    if (!(local.keyPacket instanceof SecretKeyPacket)) throw new Error('Expected a private signing fixture');
    const revoked = await subkey.revoke(local.keyPacket, { flag: enums.reasonForRevocation.keyCompromised }, rotatedAt);
    await subkey.update(revoked);
    await expect(authenticateNodeChecksum(checksums, target, [local.toPublic()])).rejects.toThrow(
      NodeChecksumSignatureError,
    );
  });

  it('preserves signatures made before ordinary retirement, and rejects later ones', async () => {
    const retired = await original.revoke({ flag: enums.reasonForRevocation.keyRetired }, rotatedAt);
    expect(await authenticateNodeChecksum(checksums, target, [retired.toPublic()])).toBe(digest);
    const newer = await signChecksum(original, afterRotation);
    await expect(authenticateNodeChecksum(newer, target, [retired.toPublic()])).rejects.toThrow(
      NodeChecksumSignatureError,
    );
  });

  it('can verify historical signatures made before a certificate expired', async () => {
    const expired = await releaser('Now expired', 2 * 24 * 60 * 60);
    expect(await authenticateNodeChecksum(await signChecksum(expired, signedAt), target, [expired.toPublic()])).toBe(
      digest,
    );
  });

  it('carries a primary revocation across omission and withdrawal without reauthorizing an absent certificate', async () => {
    const revoked = await original.revoke({ flag: enums.reasonForRevocation.keyCompromised }, rotatedAt);
    const fp = original.getFingerprint().toUpperCase();
    const snapshot: ReleaseKeySnapshot = {
      revision: '',
      certificates: { [fp]: revoked.toPublic().armor() },
      revocations: {},
    };
    await expect(authenticateNodeChecksum(checksums, target, await snapshotKeys(snapshot))).rejects.toThrow(
      NodeChecksumSignatureError,
    );
    expect(snapshot.revocations[fp + '/' + fp]).toHaveLength(1);
    const withdrawn = { ...snapshot, certificates: {} };
    expect(await snapshotKeys(withdrawn)).toEqual([]);
    const restored = { ...withdrawn, certificates: { [fp]: original.toPublic().armor() } };
    await expect(authenticateNodeChecksum(checksums, target, await snapshotKeys(restored))).rejects.toThrow(
      NodeChecksumSignatureError,
    );
    expect(restored.revocations[fp + '/' + fp]).toHaveLength(1);
  });

  it('applies a remembered subkey revocation only to its subject, including after the subkey was absent', async () => {
    const rotated = await original.addSubkey({ sign: true, date: rotatedAt });
    const added = rotated.getSubkeys().find((key) => !original.getSubkeys(key.getKeyID()).length)!;
    const rotatedArmor = rotated.toPublic().armor();
    const signedByAdded = await signChecksum(rotated, afterRotation, added);
    if (!(rotated.keyPacket instanceof SecretKeyPacket)) throw new Error('Expected a private signing fixture');
    await added.update(
      await added.revoke(rotated.keyPacket, { flag: enums.reasonForRevocation.keyCompromised }, afterRotation),
    );
    const fp = original.getFingerprint().toUpperCase();
    const snapshot: ReleaseKeySnapshot = {
      revision: '',
      certificates: { [fp]: rotated.toPublic().armor() },
      revocations: {},
    };
    await snapshotKeys(snapshot);
    const shortened = await snapshotKeys({ ...snapshot, certificates: { [fp]: original.toPublic().armor() } });
    await expect(authenticateNodeChecksum(signedByAdded, target, shortened)).rejects.toThrow(
      UnrecognizedNodeSignerError,
    );
    const restored = await snapshotKeys({ ...snapshot, certificates: { [fp]: rotatedArmor } });
    await expect(authenticateNodeChecksum(signedByAdded, target, restored)).rejects.toThrow(NodeChecksumSignatureError);
    expect(await authenticateNodeChecksum(checksums, target, restored)).toBe(digest);
  });

  it('never remembers another primary key’s revocation as evidence against a trusted key', async () => {
    const revoked = await replacement.revoke({ flag: enums.reasonForRevocation.keyCompromised }, rotatedAt);
    const fp = original.getFingerprint().toUpperCase();
    const key = original.toPublic();
    key.revocationSignatures.push(revoked.revocationSignatures[0]!);
    const snapshot: ReleaseKeySnapshot = { revision: '', certificates: { [fp]: key.armor() }, revocations: {} };
    expect(await authenticateNodeChecksum(checksums, target, await snapshotKeys(snapshot))).toBe(digest);
    expect(snapshot.revocations).toEqual({});
  });
});
