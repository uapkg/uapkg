import { readCleartextMessage, readKeys, verify, type PublicKey } from 'openpgp';

export class NodeChecksumSignatureError extends Error {}

export class UnrecognizedNodeSignerError extends NodeChecksumSignatureError {
  constructor() {
    super('Node checksums have no recognized upstream signature.');
    this.name = 'UnrecognizedNodeSignerError';
  }
}

export async function readNodeReleaseKey(bytes: Uint8Array, expectedFingerprint: string): Promise<PublicKey> {
  const armor = Buffer.from(bytes).toString('utf8').trim();
  if (
    !armor.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----') ||
    !armor.endsWith('-----END PGP PUBLIC KEY BLOCK-----') ||
    armor.match(/-----BEGIN PGP /g)?.length !== 1
  ) {
    throw new Error('Expected a single armored public Node release key.');
  }
  const keys = await readKeys({ armoredKeys: armor, config: { ignoreUnsupportedPackets: false } });
  const [key] = keys;
  if (keys.length !== 1 || !key || key.isPrivate()) throw new Error('Expected a single public Node release key.');
  if (key.getFingerprint().toUpperCase() !== expectedFingerprint.toUpperCase()) {
    throw new Error('Node release signing fingerprint mismatch.');
  }
  return key;
}

export interface NodeChecksumTarget {
  readonly version: string;
  readonly asset: string;
}

/** Authenticate the exact release and its requested asset with the current signing keys. */
export async function authenticateNodeChecksum(
  signed: string,
  target: NodeChecksumTarget,
  keys: readonly PublicKey[],
): Promise<string> {
  const message = await readCleartextMessage({ cleartextMessage: signed });
  const issuers = new Set(message.getSigningKeyIDs().map((id) => id.toHex()));
  const candidates = keys.filter((key) => key.getKeyIDs().some((id) => issuers.has(id.toHex())));
  if (!candidates.length) throw new UnrecognizedNodeSignerError();

  // expectSigned requires a verified signature, including its signing-subkey binding.
  // OpenPGP checks expiration at signing and applies compromise revocations retroactively.
  const checked = await verify({ message, verificationKeys: candidates, expectSigned: true }).catch(
    (cause: unknown) => {
      throw new NodeChecksumSignatureError('Node release checksum signature verification failed.', { cause });
    },
  );
  const entries = checked.data.split(/\r?\n/).map((line) => /^([a-f0-9]{64})\s{2}(\S+)$/.exec(line));
  // Node names its source tarball with the exact release even where the binary is just win-x64/node.exe.
  const sources = entries.filter((entry) => entry && /^node-v\d+\.\d+\.\d+\.tar\.gz$/.test(entry[2]!));
  if (sources.length !== 1 || sources[0]?.[2] !== 'node-v' + target.version + '.tar.gz') {
    throw new Error('Signed Node checksums do not identify the requested release ' + target.version + '.');
  }
  const matches = entries.filter((match) => match?.[2] === target.asset);
  if (matches.length !== 1) throw new Error('No unique signed official Node artifact for ' + target.asset);
  return matches[0]![1]!;
}
