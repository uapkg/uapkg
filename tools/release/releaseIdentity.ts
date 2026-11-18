import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assertExactVersion, assertProduct } from './ReleaseContract.ts';
import { launcherVersionFromCargo } from './NativeBuild.ts';

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

export function validateReleaseIdentity(
  product: unknown,
  requested: unknown,
  smokeLauncher: string,
  complete = false,
): boolean {
  assertProduct(product);
  assertExactVersion(requested);
  const root = path.resolve(import.meta.dirname, '../..');
  const actual =
    product === 'launcher'
      ? launcherVersionFromCargo(root)
      : (JSON.parse(readFileSync(path.join(root, 'packages/uapkg/package.json'), 'utf8')) as { version: string })
          .version;
  if (actual !== requested && !complete)
    throw new Error(`Requested ${product} ${requested} differs from the committed version ${actual}.`);
  if (product === 'cli' && !complete) assertExactVersion(smokeLauncher);
  assertReleasePublicKeys(
    { artifact: process.env.UAPKG_RELEASE_PUBLIC_KEY, catalog: process.env.UAPKG_CATALOG_PUBLIC_KEY },
    {
      artifact: readFileSync(path.join(root, 'docs/release-signing.pub'), 'utf8'),
      catalog: readFileSync(path.join(root, 'docs/release-catalog-signing.pub'), 'utf8'),
    },
  );
  return actual === requested;
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    const current = validateReleaseIdentity(
      process.env.RELEASE_PRODUCT,
      process.env.RELEASE_VERSION,
      process.env.SMOKE_LAUNCHER_VERSION ?? '',
      process.env.RELEASE_COMPLETE === 'true',
    );
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `current=${current}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
