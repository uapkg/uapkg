import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { executeCatalogCommand, type CatalogCommand } from '../catalogCommand.ts';
import { HISTORICAL_PLATFORMS } from '../ReleaseContract.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'uapkg-atomic-status-'));
  directories.push(directory);
  const remote = path.join(directory, 'remote.git');
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '--bare', '--quiet', remote);
  git('init', '--quiet', '--initial-branch=catalog-release');
  const folder = path.join(directory, 'cli', '1.2.3');
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    path.join(folder, 'entry.json'),
    JSON.stringify({
      schemaVersion: 1,
      product: 'cli',
      version: '1.2.3',
      publishedAt: '2026-11-19T00:00:00Z',
      tag: '@uapkg/cli@1.2.3',
      files: HISTORICAL_PLATFORMS,
    }) + '\n',
  );
  git('add', 'cli');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'seed');
  git('push', remote, 'HEAD:refs/heads/catalog-release');
  const source = git('rev-parse', 'HEAD');
  const command: CatalogCommand = {
    commandId: randomUUID(),
    product: 'cli',
    version: '1.2.3',
    operation: 'yank',
    reason: 'Broken resolver',
    expectedCatalogRevision: source,
    issuedAt: new Date(Date.now() - 2000).toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  const ref = (name: string) => git('--git-dir', remote, 'rev-parse', 'refs/heads/' + name);
  return { remote, git, source, command, ref };
}
describe('operator catalog commands', () => {
  it('atomically records the release and receipt, and recovers applied, no-change, and stale results after later writes', () => {
    const { remote, git, source, command, ref } = fixture();
    const noop = {
      ...command,
      commandId: randomUUID(),
      issuedAt: new Date(Date.parse(command.issuedAt) - 1).toISOString(),
      operation: 'unyank' as const,
      reason: '',
    };
    const originalNoop = executeCatalogCommand(remote, noop);
    expect(originalNoop).toMatchObject({ outcome: 'no_change', catalogRevision: source });
    expect(ref('catalog-release')).toBe(source);
    const applied = executeCatalogCommand(remote, command);
    expect(applied).toMatchObject({ outcome: 'applied', catalogRevision: ref('catalog-release') });
    expect(applied.catalogRevision).not.toBe(source);
    const receipt = JSON.parse(
      git(
        '--git-dir',
        remote,
        'show',
        `refs/heads/catalog-status-commands:commands/${command.commandId.slice(0, 2)}/${command.commandId}.json`,
      ),
    );
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          1,
          command.commandId,
          source,
          'cli',
          '1.2.3',
          'yank',
          'Broken resolver',
          command.issuedAt,
          command.expiresAt,
        ]),
      )
      .digest('hex');
    expect(receipt).toEqual({ digest, result: applied });
    expect(git('--git-dir', remote, 'diff-tree', '--no-commit-id', '--name-only', '-r', applied.catalogRevision)).toBe(
      'cli/1.2.3/entry.json',
    );
    const staleCommand = { ...noop, commandId: randomUUID() };
    const stale = executeCatalogCommand(remote, staleCommand);
    expect(stale).toMatchObject({ outcome: 'stale', catalogRevision: applied.catalogRevision });
    const cleared = executeCatalogCommand(remote, {
      ...noop,
      commandId: randomUUID(),
      expectedCatalogRevision: applied.catalogRevision,
      issuedAt: new Date(Date.parse(command.issuedAt) + 1).toISOString(),
    });
    expect(cleared.outcome).toBe('applied');
    const ledger = ref('catalog-status-commands');
    const expired = () => Date.parse(command.expiresAt);
    expect(executeCatalogCommand(remote, command, expired)).toEqual(applied);
    expect(executeCatalogCommand(remote, noop, expired)).toEqual(originalNoop);
    expect(executeCatalogCommand(remote, staleCommand)).toEqual(stale);
    expect(() => executeCatalogCommand(remote, { ...command, reason: 'Different intent' })).toThrow(
      'different release status intent',
    );
    expect(() =>
      executeCatalogCommand(remote, { ...command, expectedCatalogRevision: cleared.catalogRevision }),
    ).toThrow('different release status intent');
    expect(ref('catalog-status-commands')).toBe(ledger);
    expect(ref('catalog-release')).toBe(cleared.catalogRevision);
  }, 90_000);
  it('leaves the catalog untouched if the server refuses the receipt ref', () => {
    const { remote, git, command, source, ref } = fixture();
    // Reject new receipts through the remote's normal update hook.
    writeFileSync(path.join(remote, 'hooks', 'update'), '#!/bin/sh\n[ "$1" != refs/heads/catalog-status-commands ]\n', {
      mode: 0o755,
    });
    expect(() => executeCatalogCommand(remote, command)).toThrow('Atomic release status push failed');
    expect(ref('catalog-release')).toBe(source);
    expect(git('--git-dir', remote, 'for-each-ref', 'refs/heads/catalog-status-commands')).toBe('');
  }, 30_000);
  it('refuses a delayed command after a newer no-op even though the catalog head is unchanged', () => {
    const { remote, source, command, ref } = fixture();
    const newer = {
      ...command,
      commandId: randomUUID(),
      issuedAt: new Date(Date.parse(command.issuedAt) + 1).toISOString(),
      operation: 'unquarantine' as const,
      reason: '',
    };
    expect(executeCatalogCommand(remote, newer).outcome).toBe('no_change');
    expect(executeCatalogCommand(remote, command)).toMatchObject({ outcome: 'stale', catalogRevision: source });
    expect(
      executeCatalogCommand(remote, { ...command, commandId: randomUUID(), issuedAt: newer.issuedAt }).outcome,
    ).toBe('stale');
    expect(ref('catalog-release')).toBe(source);
  }, 60_000);
  it('rejects an approval that expires before publication and remembers that rejection', () => {
    const { remote, source, command, ref } = fixture();
    const valid = Date.parse(command.expiresAt) - 1;
    let reads = 0;
    const result = executeCatalogCommand(remote, command, () => (++reads <= 2 ? valid : valid + 1));
    expect(result).toMatchObject({ outcome: 'stale', catalogRevision: source });
    expect(executeCatalogCommand(remote, command, () => valid)).toEqual(result);
    expect(() =>
      executeCatalogCommand(remote, { ...command, expiresAt: new Date(valid + 2000).toISOString() }),
    ).toThrow('different release status intent');
    expect(ref('catalog-release')).toBe(source);
  }, 60_000);
  it('rejects invalid commands before opening the remote', () => {
    const { command } = fixture();
    expect(() => executeCatalogCommand('not-used', { ...command, expiresAt: '2026-02-30T01:00:00.000Z' })).toThrow(
      'approval window',
    );
    expect(() => executeCatalogCommand('not-used', { ...command, expiresAt: command.issuedAt })).toThrow(
      'approval window',
    );
    expect(() => executeCatalogCommand('not-used', { ...command, commandId: '../file' })).toThrow('command UUID');
    expect(() => executeCatalogCommand('not-used', { ...command, expectedCatalogRevision: 'main' })).toThrow(
      'revision',
    );
    expect(() => executeCatalogCommand('not-used', { ...command, operation: 'unquarantine' })).toThrow('public reason');
  });
});
