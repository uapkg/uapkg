import { randomUUID } from 'node:crypto';
import type { CompositionRoot } from '#cli/app/CompositionRoot.ts';
import type { UAPKGLifecycleCommandName, UAPKGOutputFormat } from '#cli/cli/UAPKGCommandLine.ts';
import { describeControlPlaneError } from '#cli/control-plane/AccountManager.ts';
import { AuthenticationSelector } from '#cli/control-plane/AuthenticationSelector.ts';
import { ControlPlaneClient } from '#cli/control-plane/ControlPlaneClient.ts';
import { RequestWatch } from '#cli/control-plane/RequestWatch.ts';
import { resolvePackageTrust } from '#cli/control-plane/resolvePackageTrust.ts';
import {
  type ControlPlaneAuthMode,
  ControlPlaneError,
  type RegistryRequestDetail,
  type RegistryRequestStatus,
  type RegistryRequestSubmission,
} from '#cli/control-plane/ControlPlaneTypes.ts';
import { PublishIdempotencyStore } from '#cli/control-plane/PublishIdempotencyStore.ts';
import { InkPromptService } from '#cli/prompts/InkPromptService.tsx';
import {
  formatRegistryRequestTerminal,
  isRegistryRequestSuccessStatus,
  isRegistryRequestTerminalStatus,
} from '#cli/reporting/RegistryRequestTerminalFormatter.ts';
import type { Command } from '#cli/commands/Command.ts';

const WATCH_TIMEOUT_MS = 30 * 60 * 1000;
const REASON_REQUIRED: ReadonlySet<UAPKGLifecycleCommandName> = new Set(['yank', 'unyank', 'unpublish', 'deprecate']);

export interface PackageLifecycleCommandOptions {
  readonly operation: UAPKGLifecycleCommandName;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly reason?: string;
  readonly registry?: string;
  readonly auth: ControlPlaneAuthMode;
  readonly detach: boolean;
  readonly outputFormat: UAPKGOutputFormat;
}

/**
 * Shared implementation of the five route-derived package lifecycle
 * operations (`uapkg yank|unyank|unpublish|deprecate|undeprecate`). Each
 * command posts to its dedicated submission route and watches the request
 * to readiness unless detached.
 */
export class PackageLifecycleCommand implements Command {
  public constructor(
    private readonly root: CompositionRoot,
    private readonly options: PackageLifecycleCommandOptions,
  ) {}

  public async execute(): Promise<number> {
    try {
      const { operation, packageName, packageVersion } = this.options;
      if (!packageName.trim() || !packageVersion.trim()) {
        throw new Error(`uapkg ${operation} requires a package name and an exact version.`);
      }
      const reason = this.options.reason?.trim();
      if (REASON_REQUIRED.has(operation) && !reason) {
        throw new Error(`uapkg ${operation} requires --reason describing why the version is changing state.`);
      }

      const trust = await resolvePackageTrust(this.root, packageName.trim(), this.options.registry);
      const selector = new AuthenticationSelector(this.root.accountManager, new InkPromptService());
      const oidcTarget = { registryId: trust.registryId, packageName: packageName.trim() };
      const requestedScopes = this.options.detach
        ? (['publishing.request.create'] as const)
        : (['publishing.request.create', 'publishing.request.read.self'] as const);
      let authentication = await selector.select(this.options.auth, trust, requestedScopes, true, oidcTarget);
      let requestOtp = authentication.otp;
      authentication = { kind: authentication.kind, credential: authentication.credential };

      const submission: RegistryRequestSubmission = {
        registryId: trust.registryId,
        payload: {
          packageName: packageName.trim(),
          packageVersion: packageVersion.trim(),
          ...(reason ? { reason } : {}),
        },
      };

      const idempotencyStore = new PublishIdempotencyStore();
      const submissionDigest = PublishIdempotencyStore.submissionDigest(operation, submission);
      const idempotencyKey = idempotencyStore.getOrCreate(submissionDigest, () => randomUUID());

      const client = new ControlPlaneClient(trust.apiBaseUrl);
      let created: Awaited<ReturnType<ControlPlaneClient['submitRegistryRequest']>>;
      try {
        created = await client.submitRegistryRequest(authentication.credential, operation, submission, {
          idempotencyKey,
          otp: requestOtp,
        });
      } finally {
        // Do not retain the request-bound code during status reads or watch.
        requestOtp = undefined;
      }
      if (this.options.detach) {
        this.printCreated(created.requestId, created.status, trust.alias);
        return 0;
      }

      const readRequest = async (signal: AbortSignal) => {
        try {
          return await client.getRegistryRequestDetail(authentication.credential, created.requestId, signal);
        } catch (error) {
          if (!(error instanceof ControlPlaneError) || error.status !== 401) throw error;
          if (authentication.kind === 'gat') throw error;
          if (authentication.kind === 'login') {
            this.root.accountManager.invalidateAccessCredentials(trust);
          }
          authentication = await selector.select(
            authentication.kind,
            trust,
            ['publishing.request.read.self'],
            false,
            oidcTarget,
          );
          return client.getRegistryRequestDetail(authentication.credential, created.requestId, signal);
        }
      };
      const watch = new RequestWatch(
        Date.now() + WATCH_TIMEOUT_MS,
        `Timed out waiting for request ${created.requestId}. Check it with \`uapkg requests status ${created.requestId}\`.`,
      );
      let detail: Awaited<ReturnType<typeof readRequest>>;
      try {
        detail = await watch.read(readRequest);
        let previousStatus = '';
        while (!isRegistryRequestTerminalStatus(detail.request.status)) {
          if (this.options.outputFormat === 'text' && detail.request.status !== previousStatus) {
            process.stdout.write(
              `${detail.request.id}: ${detail.request.status}${detail.request.currentStep ? ` (${detail.request.currentStep})` : ''}\n`,
            );
            previousStatus = detail.request.status;
          }
          await watch.wait();
          detail = await watch.read(readRequest);
        }
      } finally {
        watch.dispose();
      }

      idempotencyStore.clear(submissionDigest);

      if (isRegistryRequestSuccessStatus(detail.request.status)) {
        let refreshWarning: string | undefined;
        try {
          await this.root.registryTrustResolver.forceRefresh(trust);
        } catch (error) {
          refreshWarning = error instanceof Error ? error.message : String(error);
        }
        this.printTerminal(detail, trust.alias, refreshWarning);
        return 0;
      }

      this.printTerminal(detail, trust.alias);
      return 1;
    } catch (error) {
      process.stderr.write(`${describeControlPlaneError(error)}\n`);
      return 1;
    }
  }

  private printCreated(requestId: string, status: RegistryRequestStatus, registryAlias: string): void {
    if (this.options.outputFormat === 'json') {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          operation: this.options.operation,
          registry: registryAlias,
          requestId,
          status,
        })}\n`,
      );
      return;
    }
    process.stdout.write(
      `${this.options.operation} request ${requestId} for ${this.options.packageName}@${this.options.packageVersion}: ${status}.\n`,
    );
  }

  private printTerminal(detail: RegistryRequestDetail, registryAlias: string, refreshWarning?: string): void {
    const output = formatRegistryRequestTerminal({
      detail,
      registryAlias,
      outputFormat: this.options.outputFormat,
      presentation: {
        kind: 'lifecycle',
        operation: this.options.operation,
        packageName: this.options.packageName,
        packageVersion: this.options.packageVersion,
      },
      ...(refreshWarning ? { registryRefreshWarning: refreshWarning } : {}),
    });
    process.stdout.write(output.stdout);
    if (output.stderr) process.stderr.write(output.stderr);
  }
}
