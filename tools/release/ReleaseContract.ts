import { parse } from 'semver';

export const PRODUCTS = ['cli', 'launcher'] as const;
export type ReleaseProduct = (typeof PRODUCTS)[number];
export const PLATFORMS = [
  'win-x64',
  'win-arm64',
  'darwin-x64',
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
  'linux-x64-musl',
] as const;
export type CurrentReleasePlatform = (typeof PLATFORMS)[number];
/** Immutable receipts retain the platform names they were originally signed with. */
export const HISTORICAL_PLATFORMS = [
  'win32-x64',
  'win32-arm64',
  'darwin-x64',
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
] as const;
export const KNOWN_PLATFORMS = [...PLATFORMS, 'win32-x64', 'win32-arm64'] as const;
export type ReleasePlatform = (typeof KNOWN_PLATFORMS)[number];
export const CHECKSUM_FILE = 'SHASUMS256.txt';
export const CHECKSUM_SIGNATURE = `${CHECKSUM_FILE}.minisig`;

export interface ReleaseStatus {
  at: string;
  reason: string;
}
export interface ReleaseStatuses {
  yanked?: ReleaseStatus | null;
  quarantined?: ReleaseStatus | null;
}
export interface CatalogEntry extends ReleaseStatuses {
  schemaVersion: 1;
  product: ReleaseProduct;
  version: string;
  publishedAt: string;
  tag: string;
  files: ReleasePlatform[];
}
export interface PublicRelease extends ReleaseStatuses {
  version: string;
  date: string;
  files: ReleasePlatform[];
}
export interface ProductIndex {
  schemaVersion: 1;
  product: ReleaseProduct;
  aliases: Record<string, string>;
  releases: PublicRelease[];
}
export interface ProductReplacements {
  schemaVersion: 1;
  product: ReleaseProduct;
  replacements: Record<string, string>;
}

function object(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a release object.');
  const record = value as Record<string, unknown>;
  if (
    keys.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !keys.includes(key) && !optional.includes(key))
  )
    throw new Error('Unexpected release fields.');
  return record;
}
function assertTimestamp(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')
  )
    throw new Error('Expected a full UTC timestamp.');
}
export function validateReleaseStatus(value: unknown): ReleaseStatus {
  const status = object(value, ['at', 'reason']);
  assertTimestamp(status.at);
  if (typeof status.reason !== 'string' || status.reason.trim().length === 0)
    throw new Error('Expected a nonempty release status reason.');
  return status as unknown as ReleaseStatus;
}
function assertStatuses(value: Record<string, unknown>): void {
  for (const key of ['yanked', 'quarantined']) {
    if (value[key] !== undefined && value[key] !== null) validateReleaseStatus(value[key]);
  }
}
/** Public writers omit absent statuses; readers also accept explicit null. */
export function serializeCatalogEntry(entry: CatalogEntry): string {
  const value = { ...validateEntry(entry) };
  if (value.yanked == null) delete value.yanked;
  if (value.quarantined == null) delete value.quarantined;
  return `${JSON.stringify(value, null, 2)}\n`;
}
export function assertExactVersion(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new Error('Expected an exact version.');
  const parsed = parse(value);
  const canonical = parsed && `${parsed.version}${parsed.build.length ? `+${parsed.build.join('.')}` : ''}`;
  if (
    canonical !== value ||
    (parsed!.prerelease.length > 0 && !/^(alpha|beta)\.(0|[1-9]\d*)$/.test(parsed!.prerelease.join('.')))
  ) {
    throw new Error(`Expected an exact version (stable or numbered alpha/beta), received ${JSON.stringify(value)}.`);
  }
}
export function assertProduct(value: unknown): asserts value is ReleaseProduct {
  if (!(PRODUCTS as readonly unknown[]).includes(value)) throw new Error('Unknown release product.');
}
export function assertFiles(value: unknown, complete = false): asserts value is ReleasePlatform[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    new Set(value).size !== value.length ||
    value.some((file) => !(KNOWN_PLATFORMS as readonly unknown[]).includes(file)) ||
    (complete &&
      ![PLATFORMS, HISTORICAL_PLATFORMS].some(
        (matrix) => value.length === matrix.length && matrix.every((platform) => value.includes(platform)),
      ))
  ) {
    throw new Error('Expected unique supported release platforms.');
  }
}
/** New publication must never acquire historical names or omit a current target. */
export function assertCurrentFiles(value: unknown): asserts value is CurrentReleasePlatform[] {
  assertFiles(value);
  if (value.length !== PLATFORMS.length || !PLATFORMS.every((platform) => value.includes(platform)))
    throw new Error('Expected the complete current release platform matrix.');
}
export function releaseTag(product: ReleaseProduct, version: string): string {
  assertProduct(product);
  assertExactVersion(version);
  return `${product === 'cli' ? '@uapkg/cli@' : 'uapkg-launcher@'}${version}`;
}
export function artifactName(product: ReleaseProduct, version: string, platform: ReleasePlatform): string {
  assertProduct(product);
  assertExactVersion(version);
  assertFiles([platform]);
  return `uapkg-${product}-${version}-${platform}.tar.gz`;
}
export function validateEntry(value: unknown): CatalogEntry {
  const entry = object(
    value,
    ['schemaVersion', 'product', 'version', 'publishedAt', 'tag', 'files'],
    ['yanked', 'quarantined'],
  );
  if (entry.schemaVersion !== 1) throw new Error('Unsupported release schema.');
  assertProduct(entry.product);
  assertExactVersion(entry.version);
  assertFiles(entry.files, true);
  assertTimestamp(entry.publishedAt);
  assertStatuses(entry);
  if (entry.tag !== releaseTag(entry.product, entry.version)) throw new Error('Release tag differs from its identity.');
  return entry as unknown as CatalogEntry;
}
export function validateCurrentEntry(value: unknown): CatalogEntry {
  const entry = validateEntry(value);
  assertCurrentFiles(entry.files);
  return entry;
}
function sameBase(left: string, right: string): boolean {
  const a = parse(left)!;
  const b = parse(right)!;
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}
export function validateIndex(value: unknown): ProductIndex {
  const index = object(value, ['schemaVersion', 'product', 'aliases', 'releases']);
  if (index.schemaVersion !== 1 || !Array.isArray(index.releases)) throw new Error('Unsupported product index.');
  assertProduct(index.product);
  const versions = new Set<string>();
  const unavailable = new Set<string>();
  for (const value of index.releases) {
    const release = object(value, ['version', 'date', 'files'], ['yanked', 'quarantined']);
    assertExactVersion(release.version);
    assertStatuses(release);
    if (release.quarantined != null) {
      if (!Array.isArray(release.files) || release.files.length !== 0)
        throw new Error('Quarantined public releases must have no files.');
    } else assertFiles(release.files);
    if (release.yanked != null || release.quarantined != null) unavailable.add(release.version);
    if (versions.has(release.version)) throw new Error('Duplicate release version.');
    versions.add(release.version);
    if (
      typeof release.date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(release.date) ||
      !Number.isFinite(Date.parse(release.date)) ||
      new Date(release.date).toISOString().slice(0, 10) !== release.date
    )
      throw new Error('Expected a release date.');
  }
  if (!index.aliases || typeof index.aliases !== 'object' || Array.isArray(index.aliases))
    throw new Error('Expected release aliases.');
  for (const [alias, target] of Object.entries(index.aliases)) {
    assertExactVersion(target);
    if (!versions.has(target)) throw new Error('Aliases must target a listed exact release.');
    if (unavailable.has(target)) throw new Error('Aliases must target an available release.');
    const parsed = parse(target)!;
    if (alias === 'latest') {
      if (parsed.prerelease.length) throw new Error('latest must target a stable release.');
    } else {
      const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(alpha|beta)$/.exec(alias);
      if (!match || !sameBase(alias, target) || (parsed.prerelease.length && parsed.prerelease[0] !== match[4]))
        throw new Error('Invalid preview alias target.');
    }
  }
  return index as unknown as ProductIndex;
}
export function validateReplacements(value: unknown): ProductReplacements {
  const record = object(value, ['schemaVersion', 'product', 'replacements']);
  if (record.schemaVersion !== 1) throw new Error('Unsupported replacement schema.');
  assertProduct(record.product);
  if (!record.replacements || typeof record.replacements !== 'object' || Array.isArray(record.replacements))
    throw new Error('Expected explicit replacements.');
  for (const [from, to] of Object.entries(record.replacements)) {
    assertExactVersion(from);
    assertExactVersion(to);
    if (!parse(from)!.prerelease.length || parse(to)!.prerelease.length || !sameBase(from, to))
      throw new Error('A preview replacement must target its matching stable version.');
  }
  return record as unknown as ProductReplacements;
}
export function parseChecksums(
  bytes: string,
  product: ReleaseProduct,
  version: string,
  files: readonly ReleasePlatform[],
): Map<string, string> {
  const expected = new Set(files.map((platform) => artifactName(product, version, platform)));
  const result = new Map<string, string>();
  if (!bytes.endsWith('\n')) throw new Error('Checksums must end with LF.');
  for (const line of bytes.slice(0, -1).split('\n')) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._+-]+\.tar\.gz)$/.exec(line);
    if (!match || !expected.delete(match[2])) throw new Error('Unexpected, duplicate or malformed checksum.');
    result.set(match[2], match[1]);
  }
  if (expected.size) throw new Error('Missing release checksums.');
  return result;
}
