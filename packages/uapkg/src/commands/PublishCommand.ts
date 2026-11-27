import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { readPackageClaimsFromArchive } from '@uapkg/package-claims';
import { getRegistryRepoPath } from '@uapkg/registry-core';
import { RegistryMetaSchema, type RegistryType } from '@uapkg/registry-schema';
import type { CompositionRoot } from '#cli/app/CompositionRoot.ts';
import type { UAPKGOutputFormat } from '#cli/cli/UAPKGCommandLine.ts';
import { describeControlPlaneError } from '#cli/control-plane/AccountManager.ts';
import { ArtifactObserver } from '#cli/control-plane/ArtifactObserver.ts';
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
import {
  createGitHubActionsPublishIdempotencyKey,
  PublishIdempotencyStore,
} from '#cli/control-plane/PublishIdempotencyStore.ts';
import { publishRequestDiagnosticForError } from '#cli/control-plane/PublishRequestErrorMapper.ts';
import { InkPromptService } from '#cli/prompts/InkPromptService.tsx';
import {
  formatRegistryRequestTerminal,
  isRegistryRequestSuccessStatus,
  isRegistryRequestTerminalStatus,
} from '#cli/reporting/RegistryRequestTerminalFormatter.ts';
import type { Command } from '#cli/commands/Command.ts';

const execFileAsync = promisify(execFile);
const PUBLISH_WATCH_TIMEOUT_MS = 30 * 60 * 1000;

export interface PublishCommandOptions {
  readonly registry?: string;
  readonly owner?: string;
  readonly repository?: string;
  readonly tag?: string;
  readonly asset?: string;
  readonly assetPath?: string;
  readonly auth: ControlPlaneAuthMode;
  readonly detach: boolean;
  readonly outputFormat: UAPKGOutputFormat;
}

/**
 * Artifact-first publish (PS-REQ-002): the CLI observes the exact release
 * artifact (download or `--asset-path`), reads packaged claims from it, and
 * submits the route-derived publish operation. The packaged archive — never
 * the working tree — is what gets published.
 */
export class PublishCommand implements Command {
  public constructor(
    private readonly root: CompositionRoot,
    private readonly options: PublishCommandOptions,
  ) {}

  public async execute(): Promise<number> {
    try {
      const manifestResult = await this.root.packageManifest.readManifest();
      if (!manifestResult.ok) {
        throw new Error(manifestResult.diagnostics[0]?.message ?? 'Unable to read uapkg.json.');
      }
      const manifest = manifestResult.value;

      const source = await this.resolveSource(manifest.version, manifest.publish);

      const observer = new ArtifactObserver();
      const artifact = this.options.assetPath
        ? await observer.observeLocalArchive(resolveAssetPath(this.root.cwd, this.options.assetPath))
        : await observer.downloadReleaseAsset(source.repository, source.releaseTag, source.assetName);

      try {
        const claimsResult = await readPackageClaimsFromArchive(artifact.archivePath);
        if (!claimsResult.ok) {
          throw new Error(
            claimsResult.diagnostics[0]?.message ?? 'Unable to read the packaged uapkg.json from the artifact.',
          );
        }
        const claims = claimsResult.value;
        const trust = await resolvePackageTrust(this.root, claims.name, this.options.registry, manifest);
        if (
          this.options.outputFormat === 'text' &&
          (claims.name !== manifest.name || claims.version !== manifest.version)
        ) {
          process.stderr.write(
            `Publishing ${claims.name}@${claims.version} from the packaged artifact (local manifest says ${manifest.name}@${manifest.version}).\n`,
          );
        }

        const registryType = await readTrustedRegistryType(trust.cacheShortId);
        if (registryType === 'public' && claims.private) {
          throw new Error(
            `"${claims.name}" is marked private in its packaged manifest; a public UAPKG registry does not accept private packages.`,
          );
        }

        const scopedOwner = scopedOwnerName(claims.name);
        const configuredOwner = normalizeOwner(this.options.owner ?? manifest.publish?.owner);
        if (scopedOwner && configuredOwner && configuredOwner.toLowerCase() !== scopedOwner.toLowerCase()) {
          throw new Error(
            `Package "${claims.name}" belongs to the "${scopedOwner}" namespace; --owner cannot select "${configuredOwner}".`,
          );
        }
        const owner = scopedOwner ?? configuredOwner;

        const selector = new AuthenticationSelector(this.root.accountManager, new InkPromptService());
        const oidcTarget = { registryId: trust.registryId, packageName: claims.name };
        const requestedScopes = this.options.detach
          ? (['publishing.request.create'] as const)
          : (['publishing.request.create', 'publishing.request.read.self'] as const);
        let authentication = await selector.select(this.options.auth, trust, requestedScopes, true, oidcTarget);
        let requestOtp = authentication.otp;
        authentication = { kind: authentication.kind, credential: authentication.credential };

        const submission: RegistryRequestSubmission = {
          registryId: trust.registryId,
          ...(owner ? { ownerOrganizationName: owner } : {}),
          payload: {
            packageName: claims.name,
            packageVersion: claims.version,
            source,
            observedIntegrity: { sha256: artifact.sha256, sizeBytes: artifact.sizeBytes },
            claims,
          },
        };

        const idempotencyStore = new PublishIdempotencyStore();
        const submissionDigest = PublishIdempotencyStore.submissionDigest('publish', submission);
        const usesActionsIdempotency = authentication.kind === 'oidc';
        const idempotencyKey = usesActionsIdempotency
          ? createGitHubActionsPublishIdempotencyKey({
              registryId: trust.registryId,
              packageName: claims.name,
              packageVersion: claims.version,
              artifactSha256: artifact.sha256,
            })
          : idempotencyStore.getOrCreate(submissionDigest, () => randomUUID());

        const client = new ControlPlaneClient(trust.apiBaseUrl);
        let created: Awaited<ReturnType<ControlPlaneClient['submitRegistryRequest']>>;
        try {
          created = await client.submitRegistryRequest(authentication.credential, 'publish', submission, {
            idempotencyKey,
            otp: requestOtp,
          });
        } catch (error) {
          if (this.options.outputFormat === 'json') throw error;
          this.root.diagnostics.reportOne(
            publishRequestDiagnosticForError(error, {
              packageName: claims.name,
              packageVersion: claims.version,
              registryAlias: trust.alias,
              registryName: trust.registryName,
              registryIssuer: trust.issuer,
              credentialKind: authentication.kind,
              ...(owner ? { requestedOwner: owner } : {}),
              repository: source.repository,
            }),
          );
          return 1;
        } finally {
          // The request-scoped proof must not remain reachable while the CLI
          // polls, refreshes credentials, or watches the durable request.
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
          Date.now() + PUBLISH_WATCH_TIMEOUT_MS,
          `Timed out waiting for publishing request ${created.requestId}. Check it with \`uapkg requests status ${created.requestId}\`.`,
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

        if (!usesActionsIdempotency) idempotencyStore.clear(submissionDigest);

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
      } finally {
        await artifact.cleanup();
      }
    } catch (error) {
      process.stderr.write(`${describeControlPlaneError(error)}\n`);
      return 1;
    }
  }

  private async resolveSource(
    packageVersion: string,
    manifestPublish:
      | {
          readonly repository?: string;
          readonly asset?: string;
        }
      | undefined,
  ) {
    const repository = normalizeGitHubRepository(
      this.options.repository ?? manifestPublish?.repository ?? (await this.gitOrigin()),
    );
    const releaseTag = (this.options.tag ?? `v${packageVersion}`).trim();
    const assetName = (this.options.asset ?? manifestPublish?.asset ?? 'package.tgz').trim();
    if (!releaseTag) throw new Error('The GitHub Release tag cannot be empty.');
    if (!assetName || assetName.includes('/') || assetName.includes('\\')) {
      throw new Error('The GitHub Release asset must be a file name, not a path.');
    }
    return {
      type: 'github_release' as const,
      repository,
      releaseTag,
      assetName,
    };
  }

  private async gitOrigin(): Promise<string> {
    const git = (this.root.config.get('git') as string | null) ?? 'git';
    try {
      const { stdout } = await execFileAsync(git, ['remote', 'get-url', 'origin'], {
        cwd: this.root.cwd,
        timeout: 10_000,
      });
      return stdout.trim();
    } catch (error) {
      throw new Error('Unable to derive the GitHub repository from remote "origin". Use --repository.', {
        cause: error,
      });
    }
  }

  private printCreated(requestId: string, status: RegistryRequestStatus, registryAlias: string): void {
    if (this.options.outputFormat === 'json') {
      process.stdout.write(`${JSON.stringify({ ok: true, registry: registryAlias, requestId, status })}\n`);
      return;
    }
    process.stdout.write(`Publishing request ${requestId} submitted to "${registryAlias}" (${status}).\n`);
  }

  private printTerminal(detail: RegistryRequestDetail, registryAlias: string, refreshWarning?: string): void {
    const output = formatRegistryRequestTerminal({
      detail,
      registryAlias,
      outputFormat: this.options.outputFormat,
      presentation: { kind: 'publish' },
      ...(refreshWarning ? { registryRefreshWarning: refreshWarning } : {}),
    });
    process.stdout.write(output.stdout);
    if (output.stderr) process.stderr.write(output.stderr);
  }
}

/** Reads the installer-trusted registry type from the projected registry snapshot. */
export async function readTrustedRegistryType(cacheShortId: string): Promise<RegistryType> {
  const metaPath = join(getRegistryRepoPath(cacheShortId), '.uapkg', 'registry.meta.json');
  if (!existsSync(metaPath)) {
    throw new Error('Trusted registry metadata is missing; registry policy cannot be determined.');
  }
  try {
    const raw = await readFile(metaPath, 'utf8');
    const parsed = RegistryMetaSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) {
      throw new Error('metadata does not match a supported registry schema');
    }
    return parsed.data.registry.registryType;
  } catch (error) {
    throw new Error('Trusted registry metadata is invalid or uses an unsupported schema version.', { cause: error });
  }
}

function resolveAssetPath(cwd: string, assetPath: string): string {
  return isAbsolute(assetPath) ? assetPath : join(cwd, assetPath);
}

function normalizeGitHubRepository(input: string): string {
  let value = input.trim();
  const scp = value.match(/^git@github\.com:([^/]+)\/(.+)$/i);
  if (scp) value = `${scp[1]}/${scp[2]}`;

  if (value.includes('://')) {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== 'github.com') {
      throw new Error('Publishing sources must be hosted on github.com in UAPKG v1.');
    }
    value = url.pathname.replace(/^\/+/, '');
  }
  value = value.replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('Expected a GitHub repository in owner/repository form.');
  }
  return value.toLowerCase();
}

function scopedOwnerName(packageName: string): string | undefined {
  const match = packageName.match(/^@([^/]+)\/[^/]+$/);
  return match?.[1]?.toLowerCase();
}

function normalizeOwner(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const owner = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(owner)) {
    throw new Error('The publish owner must be a valid UAPKG organization name.');
  }
  return owner;
}
