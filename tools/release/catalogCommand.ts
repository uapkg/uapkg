import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertExactVersion, assertProduct, validateReleaseStatus } from './ReleaseContract.ts';
import { RELEASE_STATUS_OPERATIONS, updateReleaseEntry, type ReleaseStatusRequest } from './releaseStatusMutation.ts';

export interface CatalogCommand extends ReleaseStatusRequest {
  commandId: string;
  expectedCatalogRevision: string;
  issuedAt: string;
  expiresAt: string;
}

export interface CatalogCommandResult {
  schemaVersion: 1;
  commandId: string;
  product: CatalogCommand['product'];
  version: string;
  operation: CatalogCommand['operation'];
  outcome: 'applied' | 'no_change' | 'stale';
  catalogRevision: string;
}

const catalogBranch = 'refs/heads/catalog-release';
const receiptsBranch = 'refs/heads/catalog-status-commands';
const revisionPattern = /^[0-9a-f]{40}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function utcMillis(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

/** Retries can recover the original receipt after another publication or a lost push acknowledgement. */
export function executeCatalogCommand(
  remote: string,
  input: CatalogCommand,
  clock: () => number = Date.now,
): CatalogCommandResult {
  const { commandId, product, version, operation, expectedCatalogRevision, issuedAt, expiresAt } = input;
  if (!uuidPattern.test(commandId) || !revisionPattern.test(expectedCatalogRevision))
    throw new Error('Expected a command UUID and an exact reviewed catalog revision.');
  if (!utcMillis(issuedAt) || !utcMillis(expiresAt) || issuedAt >= expiresAt)
    throw new Error('Expected an ordered command approval window in UTC milliseconds.');
  const start = Date.parse(issuedAt);
  const deadline = Date.parse(expiresAt);
  const approvalIsCurrent = () => {
    const time = clock();
    return start <= time && time < deadline;
  };
  const now = new Date(clock()).toISOString();
  assertProduct(product);
  assertExactVersion(version);
  if (!RELEASE_STATUS_OPERATIONS.includes(operation)) throw new Error('Unknown release status operation.');
  const reason = input.reason?.trim() ?? '';
  if (operation === 'yank' || operation === 'quarantine') validateReleaseStatus({ at: now, reason });
  else if (reason) throw new Error('Clearing a release status does not accept a public reason.');
  const digest = createHash('sha256')
    .update(
      JSON.stringify([1, commandId, expectedCatalogRevision, product, version, operation, reason, issuedAt, expiresAt]),
    )
    .digest('hex');
  const receiptPath = `commands/${commandId.slice(0, 2)}/${commandId}.json`;
  const targetPath = `targets/${product}/${version}.json`;
  const identity = { schemaVersion: 1 as const, commandId, product, version, operation };
  for (let attempt = 0; attempt < 5; attempt++) {
    const work = mkdtempSync(path.join(os.tmpdir(), 'uapkg-status-command-'));
    try {
      const command = (args: string[], stdin?: string) =>
        spawnSync('git', args, {
          cwd: work,
          input: stdin,
          encoding: 'utf8',
          windowsHide: true,
          env: { ...process.env, UAPKG_RELEASE_SECRET_KEY: undefined, GIT_TERMINAL_PROMPT: '0' },
        });
      const git = (args: string[], stdin?: string) => {
        const result = command(args, stdin);
        if (result.error || result.status !== 0) throw new Error(`Catalog git ${args[0]} failed.`);
        return result.stdout.trim();
      };
      git(['init', '--quiet']);
      git(['config', 'user.name', 'github-actions[bot]']);
      git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
      git(['remote', 'add', 'origin', remote]);
      const heads = () => git(['ls-remote', '--heads', 'origin', catalogBranch, receiptsBranch]);
      const observed = heads();
      const withReceipts = observed.split('\n').some((line) => line.endsWith('\t' + receiptsBranch));
      // Compare against the actual fetched commit. ls-remote may have observed an earlier head.
      git([
        'fetch',
        '--quiet',
        '--no-tags',
        '--depth=1',
        'origin',
        catalogBranch + ':refs/local/catalog',
        ...(withReceipts ? [receiptsBranch + ':refs/local/receipts'] : []),
      ]);
      const source = git(['rev-parse', 'refs/local/catalog']);
      const previous = withReceipts ? git(['rev-parse', 'refs/local/receipts']) : undefined;
      if (previous && git(['ls-tree', previous, '--', receiptPath])) {
        const receipt = JSON.parse(git(['show', previous + ':' + receiptPath]));
        if (receipt.digest !== digest)
          throw new Error('Command ID already identifies a different release status intent.');
        const { result } = receipt;
        if (
          !result ||
          Object.entries(identity).some(([key, value]) => result[key] !== value) ||
          !['applied', 'no_change', 'stale'].includes(result.outcome) ||
          typeof result.catalogRevision !== 'string' ||
          !revisionPattern.test(result.catalogRevision)
        )
          throw new Error('Invalid release status command receipt.');
        return { ...identity, outcome: result.outcome, catalogRevision: result.catalogRevision };
      }
      let outcome: CatalogCommandResult['outcome'] = 'stale';
      let catalogRevision = source;
      let lastIssuedAt: string | undefined;
      if (previous && git(['ls-tree', previous, '--', targetPath])) {
        const marker: unknown = JSON.parse(git(['show', previous + ':' + targetPath]));
        if (!utcMillis(marker)) throw new Error('Invalid release status command ordering record.');
        lastIssuedAt = marker;
      }
      if (source === expectedCatalogRevision && (!lastIssuedAt || issuedAt > lastIssuedAt) && approvalIsCurrent()) {
        git(['checkout', '--quiet', '--detach', source]);
        if (updateReleaseEntry(work, input, now)) {
          git(['add', '--', `${product}/${version}/entry.json`]);
          git(['commit', '--quiet', '-m', `${operation} ${product} ${version}`]);
          catalogRevision = git(['rev-parse', 'HEAD']);
          outcome = 'applied';
        } else outcome = 'no_change';
      }
      const result = { ...identity, outcome, catalogRevision };
      // The public catalog tree is unchanged for a no-op/rejection. The independent
      // receipt ref records those outcomes, too, without triggering a site rebuild.
      const blob = git(['hash-object', '-w', '--stdin'], JSON.stringify({ digest, result }) + '\n');
      git(previous ? ['read-tree', previous] : ['read-tree', '--empty']);
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${receiptPath}`]);
      if (outcome !== 'stale') {
        // An accepted no-op also supersedes older, delayed commands on the same release.
        const marker = git(['hash-object', '-w', '--stdin'], JSON.stringify(issuedAt) + '\n');
        git(['update-index', '--add', '--cacheinfo', `100644,${marker},${targetPath}`]);
      }
      const tree = git(['write-tree']);
      const nextReceipt = git([
        'commit-tree',
        tree,
        ...(previous ? ['-p', previous] : []),
        '-m',
        `Record release status command ${commandId}`,
      ]);
      const refs = [`${nextReceipt}:${receiptsBranch}`];
      if (outcome === 'applied') refs.push(`${catalogRevision}:${catalogBranch}`);
      // An unchanged ref is omitted by the git push protocol. Observe both heads
      // again before recording a read-only outcome against the reviewed source.
      if (outcome !== 'applied' && heads() !== observed) continue;
      // No unexpired approval means no new release effect. Refetch on expiry so an
      // already published outcome can still win before recording a stale receipt.
      if (outcome !== 'stale' && !approvalIsCurrent()) continue;
      if (command(['push', '--atomic', 'origin', ...refs]).status === 0) return result;
      // Never force either ref. A competing command, a publisher, or a successful
      // push with a lost acknowledgement will be observed on the next fresh fetch.
      if (heads() === observed) throw new Error('Atomic release status push failed.');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  throw new Error('Catalog changed repeatedly. Retry the same release status command.');
}
