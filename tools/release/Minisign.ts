import { createHash, createPublicKey, verify } from 'node:crypto';

/** Verify modern Minisign prehashed Ed25519 signatures, including their trusted comment. */
export function verifyMinisign(bytes: Uint8Array, publicKeyText: string, signatureText: string): void {
  const decode = (value: string, length: number): Buffer => {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid Minisign base64.');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== length || bytes.toString('base64') !== value)
      throw new Error('Invalid Minisign length or encoding.');
    return bytes;
  };
  const keyLines = publicKeyText.trim().split(/\r?\n/);
  const key = decode(keyLines.at(-1)!, 42);
  const lines = signatureText.trimEnd().split(/\r?\n/);
  if (lines.length !== 4 || !lines[0]!.startsWith('untrusted comment: ') || !lines[2]!.startsWith('trusted comment: '))
    throw new Error('Invalid Minisign document.');
  const signature = decode(lines[1]!, 74);
  if (
    key.subarray(0, 2).toString() !== 'Ed' ||
    signature.subarray(0, 2).toString() !== 'ED' ||
    !key.subarray(2, 10).equals(signature.subarray(2, 10))
  )
    throw new Error('Minisign key or algorithm mismatch.');
  const publicKey = createPublicKey({
    format: 'der',
    type: 'spki',
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]),
  });
  const rawSignature = signature.subarray(10);
  const comment = Buffer.from(lines[2]!.slice('trusted comment: '.length));
  if (
    !verify(null, createHash('blake2b512').update(bytes).digest(), publicKey, rawSignature) ||
    !verify(null, Buffer.concat([rawSignature, comment]), publicKey, decode(lines[3]!, 64))
  )
    throw new Error('Invalid Minisign signature.');
}
