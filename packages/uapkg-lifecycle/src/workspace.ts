import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ResolvedConfig, LifecyclePolicyResolver } from '@uapkg/config';
import type { Diagnostic } from '@uapkg/diagnostics';
import {
  IntegrationDefinitionSchema,
  reconcileWorkspaceIntegration,
  type IntegrationDefinition,
} from '@uapkg/integration/runtime';
import type { InstallReport, VerifiedRelease } from '@uapkg/installer';
import { discoverEntries, type LifecycleEntries } from '#lifecycle/entries.ts';
import { getLifecycleWorkDir, runLifecycleOnce } from '#lifecycle/state.ts';
import { orderedReleases, releaseCapabilities } from '#lifecycle/schedule.ts';
import { runLifecycleEntry } from '#lifecycle/runner.ts';
import { ManifestSchema, type Manifest, type Capability } from '@uapkg/package-manifest-schema';

export interface RetryTarget {
  packageName: string;
  registry: string;
  capability: Capability;
}

export interface WorkspaceLifecycleOptions {
  workspaceRoot: string;
  report: Pick<InstallReport, 'verifiedReleases' | 'failed' | 'skipped' | 'incompleteClosure'>;
  manifest: Manifest;
  refresh: boolean;
  ignoreScripts: boolean;
  invocation: readonly string[];
  retry?: RetryTarget;
  config: ResolvedConfig;
  withVerifiedSnapshot<T>(release: VerifiedRelease, use: (source: string) => Promise<T>): Promise<T>;
  runtime: {
    pin(selector: string): Promise<string>;
    executable(selector: string): Promise<string>;
  };
}

function shellCommand(args: readonly string[]): string {
  const quote = (value: string) => {
    if (/^[A-Za-z0-9_@./:+-]+$/.test(value)) return value;
    const escaped = process.platform === 'win32' ? value.replaceAll("'", "''") : value.replaceAll("'", "'\\''");
    return "'" + escaped + "'";
  };
  return ['uapkg', ...args].map(quote).join(' ');
}

function failed(err: unknown, packageName?: string, capability?: string, registry?: string): Diagnostic {
  const retryCommand =
    packageName && registry && capability
      ? shellCommand(['lifecycle', 'retry', packageName, '--registry', registry, '--capability', capability])
      : undefined;
  return {
    code: 'LIFECYCLE_FAILED',
    level: 'error',
    message: err instanceof Error ? err.message : String(err),
    ...(retryCommand ? { hint: retryCommand } : {}),
    data: { packageName, capability, retryCommand },
  };
}

export async function readReleaseEntries(source: string) {
  const manifest = ManifestSchema.parse(JSON.parse(await readFile(join(source, 'uapkg.json'), 'utf8')));
  return { entries: discoverEntries(source, manifest), selector: manifest.lifecycle?.runtime?.node };
}

interface DiscoveredRelease {
  release: VerifiedRelease;
  entries: LifecycleEntries;
  selector?: string;
  owner: string;
}

export async function runWorkspaceLifecycle(input: WorkspaceLifecycleOptions): Promise<Diagnostic[]> {
  const { manifest, report, retry, workspaceRoot, runtime } = input;
  const diagnostics: Diagnostic[] = [];
  const blocked = new Set<string>(report.incompleteClosure);
  let complete = !retry && !report.failed.length && !report.skipped.length && !blocked.size;
  const directPlugins: { owner: string; pluginName: string }[] = [];
  const integrations: { owner: string; definition: IntegrationDefinition }[] = [];
  const retainOwners = new Set<string>();
  const ready: DiscoveredRelease[] = [];
  const retryCommand = shellCommand(input.invocation);
  const authoredNode = manifest.lifecycle?.runtime?.node;
  if (input.refresh && !input.ignoreScripts && authoredNode) {
    try {
      if (discoverEntries(workspaceRoot, manifest, ['prepack']).prepack) await runtime.pin(authoredNode);
    } catch (error) {
      diagnostics.push(failed(error, manifest.name, 'prepack'));
    }
  }
  let retrySeen = false;

  const invoke = async (node: DiscoveredRelease, kind: Capability, source: string) => {
    if (!node.entries[kind]) return;
    const { release } = node;
    const matchesRetry =
      retry?.packageName === release.packageName && retry.registry === release.registry && retry.capability === kind;
    if (retry && !matchesRetry) {
      if (kind === 'integration') retainOwners.add(node.owner);
      return;
    }
    if (matchesRetry) retrySeen = true;
    const capabilities = releaseCapabilities(manifest.permissions?.releases, release);
    const allowed = capabilities
      ? capabilities.includes(kind)
      : new LifecyclePolicyResolver().resolve(input.config, release.registry) === 'allow';
    if (input.ignoreScripts || !allowed) {
      if (kind === 'integration' && input.ignoreScripts) retainOwners.add(node.owner);
      if (!input.ignoreScripts) {
        const approveCommand = shellCommand([
          'permissions',
          'approve',
          release.packageName,
          '--registry',
          release.registry,
          '--capability',
          kind,
        ]);
        diagnostics.push({
          code: 'LIFECYCLE_APPROVAL_REQUIRED',
          level: matchesRetry ? 'error' : 'info',
          message: `Installed ${release.packageName}@${release.version} from ${release.registry}. Skipped unapproved ${kind}.`,
          hint: `${approveCommand}\nThen repeat: ${retryCommand}`,
          data: {
            packageName: release.packageName,
            registry: release.registry,
            version: release.version,
            capability: kind,
            approveCommand,
            retryCommand,
          },
        });
      }
      return;
    }
    // Resolve an intentionally refreshed pin even when the hook already has a successful receipt.
    if (input.refresh && node.selector) await runtime.pin(node.selector);
    const result = await runLifecycleOnce({ workspaceRoot, identity: release, kind, retry: matchesRetry }, async () => {
      const value = await runLifecycleEntry({
        kind,
        packageRoot: source,
        workspaceRoot,
        workDir: getLifecycleWorkDir(workspaceRoot, release),
        entry: node.entries[kind]!,
        nodeExecutable: node.selector ? await runtime.executable(node.selector) : undefined,
      });
      return kind === 'integration' ? IntegrationDefinitionSchema.parse(value) : null;
    });
    if (kind === 'integration')
      integrations.push({ owner: node.owner, definition: IntegrationDefinitionSchema.parse(result.value) });
  };

  for (const release of orderedReleases(report.verifiedReleases)) {
    let capability: Capability | undefined;
    try {
      await input.withVerifiedSnapshot(release, async (source) => {
        const owner = `${release.registryId}/${release.packageName}`;
        if (Object.hasOwn(manifest.dependencies ?? {}, release.packageName)) {
          const descriptors = (await readdir(source, { withFileTypes: true })).filter(
            (f) => f.isFile() && f.name.toLowerCase().endsWith('.uplugin'),
          );
          if (descriptors.length !== 1)
            throw new Error(`${release.packageName} must contain exactly one root .uplugin descriptor.`);
          directPlugins.push({ owner: 'dependency/' + owner, pluginName: descriptors[0]!.name.slice(0, -8) });
        }
        if (blocked.has(release.packageName) || release.dependencies.some((name) => blocked.has(name))) {
          blocked.add(release.packageName);
          return;
        }
        const node = { release, owner: 'integration/' + owner, ...(await readReleaseEntries(source)) };
        capability = 'postinstall';
        await invoke(node, 'postinstall', source);
        if (manifest.kind === 'project') ready.push(node);
      });
    } catch (e) {
      complete = false;
      blocked.add(release.packageName);
      diagnostics.push(failed(e, release.packageName, capability, release.registry));
    }
  }
  for (const node of ready) {
    if (node.release.dependencies.some((name) => blocked.has(name))) {
      blocked.add(node.release.packageName);
      continue;
    }
    if (!node.entries.integration) continue;
    try {
      await input.withVerifiedSnapshot(node.release, (source) => invoke(node, 'integration', source));
    } catch (e) {
      complete = false;
      blocked.add(node.release.packageName);
      diagnostics.push(failed(e, node.release.packageName, 'integration', node.release.registry));
    }
  }
  if (retry && !retrySeen)
    diagnostics.push(
      failed(
        new Error(`No eligible installed ${retry.capability} entry for ${retry.packageName} from ${retry.registry}.`),
      ),
    );
  try {
    await reconcileWorkspaceIntegration({
      workspaceRoot,
      workspaceKind: manifest.kind,
      directPlugins,
      installedRoots: report.verifiedReleases.map((release) => release.installedPath),
      integrations,
      complete,
      retainOwners: [...retainOwners],
    });
  } catch (e) {
    diagnostics.push(failed(e, undefined, 'integration'));
  }
  return diagnostics;
}
