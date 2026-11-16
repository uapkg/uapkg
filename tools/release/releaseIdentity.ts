import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assertExactVersion, assertProduct } from './ReleaseContract.ts';
import { launcherVersionFromCargo } from './NativeBuild.ts';

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
  if (product === 'launcher' && !complete) {
    const artifactKey = process.env.UAPKG_RELEASE_PUBLIC_KEY?.trim();
    const metadataKey = process.env.UAPKG_CATALOG_PUBLIC_KEY?.trim();
    if (!artifactKey || !metadataKey || artifactKey === metadataKey)
      throw new Error('Launcher releases require distinct artifact and catalog public keys.');
  }
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
