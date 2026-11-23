import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { executeCatalogCommand } from './catalogCommand.ts';
import { createCatalogAdapter } from './publishCatalog.ts';
import type { ReleaseProduct } from './ReleaseContract.ts';
import { authorizeReleaseStatus } from './releaseStatusAuthorization.ts';
import { changeReleaseStatus, type ReleaseStatusOperation } from './releaseStatusMutation.ts';

export function runReleaseStatus(): void {
  const actor = authorizeReleaseStatus();
  const request = {
    product: process.env.RELEASE_PRODUCT as ReleaseProduct,
    version: process.env.RELEASE_VERSION ?? '',
    operation: process.env.RELEASE_STATUS_OPERATION as ReleaseStatusOperation,
    reason: process.env.RELEASE_STATUS_REASON,
  };
  const commandId = process.env.RELEASE_STATUS_COMMAND_ID ?? '';
  const expectedCatalogRevision = process.env.RELEASE_STATUS_EXPECTED_REVISION ?? '';
  const issuedAt = process.env.RELEASE_STATUS_ISSUED_AT ?? '';
  const expiresAt = process.env.RELEASE_STATUS_EXPIRES_AT ?? '';
  if (actor === 'dispatcher') {
    const result = executeCatalogCommand('https://github.com/uapkg/uapkg.git', {
      ...request,
      commandId,
      expectedCatalogRevision,
      issuedAt,
      expiresAt,
    });
    const output = process.env.GITHUB_OUTPUT;
    const temporary = process.env.RUNNER_TEMP;
    if (!output || !temporary) throw new Error('The current workflow result destination is unavailable.');
    writeFileSync(path.join(temporary, 'release-status-result.json'), JSON.stringify(result));
    appendFileSync(
      output,
      `command_id=${result.commandId}\noutcome=${result.outcome}\ncatalog_revision=${result.catalogRevision}\n`,
    );
    return;
  }
  if (commandId || expectedCatalogRevision || issuedAt || expiresAt)
    throw new Error('Command inputs belong to the dispatcher.');
  const result = changeReleaseStatus(
    request,
    createCatalogAdapter('uapkg/uapkg', `${request.operation} ${request.product} ${request.version}`),
  );
  process.stdout.write(`${result.changed ? 'Updated' : 'Confirmed'} ${request.product}/${request.version} status.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    runReleaseStatus();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
