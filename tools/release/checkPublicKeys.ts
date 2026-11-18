import { readFileSync } from 'node:fs';
import path from 'node:path';

interface ReleasePublicKeys {
  artifact: string | undefined;
  catalog: string | undefined;
}

function minisignPublicKey(value: string | undefined, name: string): Buffer {
  const lines = (value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('untrusted comment:'));
  const encoded = lines[0] ?? '';
  const key = Buffer.from(encoded, 'base64');
  if (
    lines.length !== 1 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
    key.length !== 42 ||
    key.toString('base64') !== encoded ||
    key.subarray(0, 2).toString() !== 'Ed'
  )
    throw new Error(`${name} must contain a valid Minisign public key.`);
  return key;
}

export function assertReleasePublicKeys(configured: ReleasePublicKeys, trusted: ReleasePublicKeys): void {
  const artifact = minisignPublicKey(configured.artifact, 'UAPKG_RELEASE_PUBLIC_KEY');
  const catalog = minisignPublicKey(configured.catalog, 'UAPKG_CATALOG_PUBLIC_KEY');
  const trustedArtifact = minisignPublicKey(trusted.artifact, 'docs/release-signing.pub');
  const trustedCatalog = minisignPublicKey(trusted.catalog, 'docs/release-catalog-signing.pub');
  if (
    artifact.subarray(10).equals(catalog.subarray(10)) ||
    trustedArtifact.subarray(10).equals(trustedCatalog.subarray(10))
  )
    throw new Error('Artifact and catalog verification keys must use distinct Ed25519 trust anchors.');
  if (!artifact.equals(trustedArtifact))
    throw new Error('UAPKG_RELEASE_PUBLIC_KEY does not match docs/release-signing.pub.');
  if (!catalog.equals(trustedCatalog))
    throw new Error('UAPKG_CATALOG_PUBLIC_KEY does not match docs/release-catalog-signing.pub.');
}

export function checkPublicKeys(root = path.resolve(import.meta.dirname, '../..')): void {
  assertReleasePublicKeys(
    { artifact: process.env.UAPKG_RELEASE_PUBLIC_KEY, catalog: process.env.UAPKG_CATALOG_PUBLIC_KEY },
    {
      artifact: readFileSync(path.join(root, 'docs/release-signing.pub'), 'utf8'),
      catalog: readFileSync(path.join(root, 'docs/release-catalog-signing.pub'), 'utf8'),
    },
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: checkPublicKeys.ts [repository-root]');
    checkPublicKeys(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
