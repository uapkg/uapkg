import { unlink } from 'node:fs/promises';
import type { ConfigInstance } from '@uapkg/config';
import { type Diagnostic, DiagnosticBag, ok, type Result } from '@uapkg/diagnostics';
import type { Lockfile } from '@uapkg/package-manifest-schema';
import type { RegistryCore } from '@uapkg/registry-core';
import pLimit from 'p-limit';
import type {
  InstallAction,
  InstallerOptions,
  InstallReport,
  PackageInstallOutcome,
} from '#installer/contracts/InstallerTypes.ts';
import type { DownloadStatusSnapshot } from '#installer/contracts/StatusStreamTypes.ts';
import { NoMarkerPolicy } from '#installer/safety/NoMarkerPolicy.ts';
import { SafetyPolicyRegistry } from '#installer/safety/SafetyPolicyRegistry.ts';
import { SlotTable } from '#installer/status/SlotTable.ts';
import { StatusStream } from '#installer/status/StatusStream.ts';
import { ClaimsVerifier } from '#installer/core/ClaimsVerifier.ts';
import { DiskStateInspector } from '#installer/core/DiskStateInspector.ts';
import { InstallPlanner } from '#installer/core/InstallPlanner.ts';
import { IntegrityVerifier } from '#installer/core/IntegrityVerifier.ts';
import { PackageDownloader } from '#installer/core/PackageDownloader.ts';
import { PackageExtractor } from '#installer/core/PackageExtractor.ts';
import { PackageRemover } from '#installer/core/PackageRemover.ts';

interface ExecutionRuntime {
  readonly slots: SlotTable;
  readonly stream: StatusStream;
}

export interface InstallerConstructorOptions {
  readonly registryCore: RegistryCore;
  readonly config: InstanceType<typeof ConfigInstance>;
}

/**
 * Physical installation orchestrator. Owns the collaborators but is not a
 * god-class — each step delegates to a single-responsibility module.
 *
 * Public surface:
 *   - execute(lockfile, previous?) → Result<InstallReport>
 *   - getStatusStream() → AsyncIterable<DownloadStatusSnapshot>
 *
 * Installation is verification-gated and partial: a package activates only
 * after exact byte-size, SHA-256, and packaged-manifest claims verification,
 * its outgoing dependency edges are trusted only after it verifies, and a
 * failed branch is reported without blocking unrelated verified branches.
 *
 * Concurrency is read from `network.maxConcurrentDownloads` in config;
 * retries/timeout from `network.retries` / `network.timeout`.
 *
 * Emits no console output. Progress flows through the status stream.
 */
export class Installer {
  private readonly inspector = new DiskStateInspector();
  private readonly planner: InstallPlanner;
  private readonly downloader = new PackageDownloader();
  private readonly verifier = new IntegrityVerifier();
  private readonly claimsVerifier = new ClaimsVerifier();
  private readonly extractor = new PackageExtractor();
  private readonly remover = new PackageRemover();
  private readonly safety = new SafetyPolicyRegistry();

  private stream: StatusStream | null = null;
  private pendingRuntime?: ExecutionRuntime;

  constructor(private readonly deps: InstallerConstructorOptions) {
    this.planner = new InstallPlanner(deps.registryCore);
    this.safety.register(new NoMarkerPolicy());
  }

  /** Expose the registry so consumers can register additional policies. */
  get safetyRegistry(): SafetyPolicyRegistry {
    return this.safety;
  }

  getStatusStream(): AsyncIterable<DownloadStatusSnapshot> {
    if (!this.stream) {
      // A subscriber may attach before the first execution starts.
      this.pendingRuntime = this.createExecutionRuntime(this.readMaxConcurrent());
      this.stream = this.pendingRuntime.stream;
    }
    return this.stream;
  }

  async execute(
    lockfile: Lockfile,
    previousLockfile: Lockfile | null,
    options: InstallerOptions,
  ): Promise<Result<InstallReport>> {
    const maxConcurrent = this.readMaxConcurrent();
    const runtime = this.pendingRuntime ?? this.createExecutionRuntime(maxConcurrent);
    this.pendingRuntime = undefined;
    this.stream = runtime.stream;
    try {
      return await this.executePlan(lockfile, previousLockfile, options, runtime, maxConcurrent);
    } finally {
      // Closing the stream lets the CLI finish reading progress and report the result, including a planning error.
      runtime.stream.close();
    }
  }

  private async executePlan(
    lockfile: Lockfile,
    previousLockfile: Lockfile | null,
    options: InstallerOptions,
    runtime: ExecutionRuntime,
    maxConcurrent: number,
  ): Promise<Result<InstallReport>> {
    const bag = new DiagnosticBag();
    // 1. Inspect disk
    const diskResult = await this.inspector.inspect(options.manifestRoot, lockfile);
    if (!diskResult.ok) return diskResult as Result<never>;

    // 2. Plan
    const planResult = await this.planner.plan(lockfile, previousLockfile, diskResult.value);
    if (!planResult.ok) return planResult as Result<never>;
    const plan = planResult.value;

    // Seed totals into SlotTable
    runtime.slots.setTotals({
      added: plan.summary.added,
      updated: plan.summary.updated,
      removed: plan.summary.removed,
      unchanged: plan.summary.unchanged,
      bytesDone: 0,
      bytesTotal: plan.summary.totalBytes,
    });
    runtime.stream.publish();

    // 3. Safety gate
    const verdictsResult = await this.safety.evaluatePlan(options.manifestRoot, plan.actions, options.force ?? false);
    if (!verdictsResult.ok) {
      bag.mergeArray(verdictsResult.diagnostics);
      return bag.toFailure();
    }

    if (options.dryRun) {
      return ok(this.emptyReport(plan));
    }

    // 4. Execute under concurrency limit with verification-gated waves.
    const limit = pLimit(maxConcurrent);
    const retries = this.readNumber('network.retries', 2);
    const timeoutSeconds = this.readNumber('network.timeout', 300);
    const net = { retries, timeoutMs: timeoutSeconds * 1000 };

    const blockedNames = new Set(verdictsResult.value.filter((v) => v.blocked).map((v) => v.action.packageName));
    const allowedActions = plan.actions.filter((action) => !blockedNames.has(action.packageName));

    const outcomes = new Map<string, PackageInstallOutcome['status']>();
    const failureDiagnostics: Diagnostic[] = [];

    for (const name of blockedNames) outcomes.set(name, 'failed');

    // Removals and unchanged bookkeeping first.
    await Promise.all(
      allowedActions
        .filter((action) => action.type === 'remove')
        .map((action) =>
          limit(async () => {
            const result = await this.executeRemove(options.manifestRoot, action, runtime);
            outcomes.set(action.packageName, result.ok ? 'removed' : 'failed');
            if (!result.ok) failureDiagnostics.push(...result.diagnostics);
          }),
        ),
    );

    // Dependency edges from the lockfile (equal to verified claims for
    // verified parents because claims comparison covers the buckets).
    const edges = new Map<string, readonly string[]>();
    for (const [name, entry] of Object.entries(lockfile.packages as Record<string, { dependencies?: object }>)) {
      edges.set(name, Object.keys(entry.dependencies ?? {}));
    }

    // Trusted roots: the root manifest's declared dependencies (or every
    // lockfile entry when the caller supplied no seeds).
    const seeds = new Set(options.rootDependencies ?? Object.keys(lockfile.packages));

    // Already-active packages are verified parents for edge admission.
    const verified = new Set<string>();
    for (const action of allowedActions) {
      if (action.type === 'unchanged') {
        verified.add(action.packageName);
        outcomes.set(action.packageName, 'unchanged');
      }
    }

    const pending = new Map<string, InstallAction>();
    for (const action of allowedActions) {
      if (action.type === 'add' || action.type === 'update') pending.set(action.packageName, action);
    }

    const failed = new Set<string>();

    while (pending.size > 0) {
      const eligible: InstallAction[] = [];
      for (const action of pending.values()) {
        if (this.isEligible(action.packageName, seeds, verified, edges)) eligible.push(action);
      }
      if (eligible.length === 0) break;

      await Promise.all(
        eligible.map((action) =>
          limit(async () => {
            pending.delete(action.packageName);
            const result = await this.executeDownloadAction(options.manifestRoot, action, net, runtime);
            if (result.ok) {
              verified.add(action.packageName);
              outcomes.set(action.packageName, 'installed');
            } else {
              failed.add(action.packageName);
              outcomes.set(action.packageName, 'failed');
              failureDiagnostics.push(...result.diagnostics);
            }
          }),
        ),
      );
    }

    // Whatever remains pending has no verified parent left to admit it.
    for (const action of pending.values()) {
      outcomes.set(action.packageName, 'skipped_no_verified_parent');
      failureDiagnostics.push(
        this.skippedDiagnostic(action.packageName, 'no trusted root or verified parent requires this package'),
      );
    }

    const report = this.buildReport(plan, outcomes, edges, verified);
    return ok(report, failureDiagnostics);
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private isEligible(
    name: string,
    seeds: ReadonlySet<string>,
    verified: ReadonlySet<string>,
    edges: ReadonlyMap<string, readonly string[]>,
  ): boolean {
    if (seeds.has(name)) return true;
    for (const parent of verified) {
      if (edges.get(parent)?.includes(name)) return true;
    }
    return false;
  }

  private emptyReport(plan: InstallReport['plan']): InstallReport {
    return { plan, outcomes: [], installed: [], failed: [], skipped: [], incompleteClosure: [] };
  }

  private buildReport(
    plan: InstallReport['plan'],
    outcomes: ReadonlyMap<string, PackageInstallOutcome['status']>,
    edges: ReadonlyMap<string, readonly string[]>,
    verified: ReadonlySet<string>,
  ): InstallReport {
    const outcomeList: PackageInstallOutcome[] = [];
    const installed: PackageInstallOutcome['packageName'][] = [];
    const failed: PackageInstallOutcome['packageName'][] = [];
    const skipped: PackageInstallOutcome['packageName'][] = [];

    for (const [rawName, status] of outcomes) {
      const packageName = rawName as PackageInstallOutcome['packageName'];
      outcomeList.push({ packageName, status });
      if (status === 'installed') installed.push(packageName);
      else if (status === 'failed') failed.push(packageName);
      else if (status === 'skipped_no_verified_parent') skipped.push(packageName);
    }

    // A verified/retained package whose declared child failed or was skipped
    // has an incomplete dependency closure.
    const unusable = new Set<string>([...failed, ...skipped]);
    const incompleteClosure: PackageInstallOutcome['packageName'][] = [];
    for (const parent of verified) {
      const children = edges.get(parent) ?? [];
      if (children.some((child) => unusable.has(child))) {
        incompleteClosure.push(parent as PackageInstallOutcome['packageName']);
      }
    }

    return {
      plan,
      outcomes: outcomeList,
      installed,
      failed,
      skipped,
      incompleteClosure,
    };
  }

  private skippedDiagnostic(packageName: string, reason: string): Diagnostic {
    const bag = new DiagnosticBag();
    bag.addError('INSTALL_SKIPPED_NO_VERIFIED_PARENT', `Skipped "${packageName}": ${reason}.`, {
      packageName,
      reason,
    });
    return bag.all()[0];
  }

  private async executeRemove(
    manifestRoot: string,
    action: InstallAction,
    runtime: ExecutionRuntime,
  ): Promise<Result<void>> {
    const { slots, stream } = runtime;
    const slotId =
      slots.claim({
        state: 'removing',
        packageName: action.packageName,
        version: action.targetVersion,
        bytesDone: 0,
        bytesTotal: action.sizeBytes,
        attempt: 1,
      }) ?? 0;
    stream.publish();

    try {
      const result = await this.remover.remove(action.packageName, manifestRoot, action.path);
      slots.update(slotId, { state: result.ok ? 'done' : 'failed' });
      stream.publish();
      slots.release(slotId);
      return result;
    } catch (err) {
      slots.update(slotId, { state: 'failed' });
      stream.publish();
      slots.release(slotId);
      return this.unexpectedFailure(action.packageName, err);
    }
  }

  private async executeDownloadAction(
    manifestRoot: string,
    action: InstallAction,
    net: { readonly retries: number; readonly timeoutMs: number },
    runtime: ExecutionRuntime,
  ): Promise<Result<void>> {
    const { slots, stream } = runtime;

    const slotId =
      slots.claim({
        state: 'downloading',
        packageName: action.packageName,
        version: action.targetVersion,
        bytesDone: 0,
        bytesTotal: action.sizeBytes,
        attempt: 1,
      }) ?? 0;
    stream.publish();

    const failSlot = (): void => {
      slots.update(slotId, { state: 'failed' });
      stream.publish();
      slots.release(slotId);
    };

    try {
      if (
        !action.downloadUrl ||
        !action.integrity ||
        !action.registryEntry ||
        action.sizeBytes === undefined ||
        action.targetVersion === undefined
      ) {
        failSlot();
        const bag = new DiagnosticBag();
        bag.addError(
          'INSTALL_ACTION_METADATA_MISSING',
          `Cannot verify "${action.packageName}": the registry record is missing its artifact URL, integrity, size, or claims.`,
          { packageName: action.packageName, version: action.targetVersion },
        );
        return bag.toFailure();
      }

      // Download
      const dl = await this.downloader.download(
        action.packageName,
        action.downloadUrl,
        { retries: net.retries, timeoutMs: net.timeoutMs },
        (bytesDone, bytesTotal, attempt) => {
          slots.update(slotId, { bytesDone, bytesTotal, attempt });
          stream.publish();
        },
      );
      if (!dl.ok) {
        failSlot();
        return dl as Result<never>;
      }

      // Verify: exact byte count, then SHA-256, then packaged-manifest claims.
      slots.update(slotId, { state: 'verifying' });
      stream.publish();

      if (dl.value.bytesDownloaded !== action.sizeBytes) {
        await this.safeUnlink(dl.value.tempPath);
        failSlot();
        const bag = new DiagnosticBag();
        bag.addError(
          'INSTALL_SIZE_MISMATCH',
          `Artifact for "${action.packageName}" is ${dl.value.bytesDownloaded} bytes but the registry declares ${action.sizeBytes}.`,
          { packageName: action.packageName, expected: action.sizeBytes, actual: dl.value.bytesDownloaded },
        );
        return bag.toFailure();
      }

      const verify = await this.verifier.verify(action.packageName, dl.value.tempPath, action.integrity);
      if (!verify.ok) {
        await this.safeUnlink(dl.value.tempPath);
        failSlot();
        return verify as Result<never>;
      }

      const claims = await this.claimsVerifier.verify({
        packageName: action.packageName,
        version: action.targetVersion,
        archivePath: dl.value.tempPath,
        registryEntry: action.registryEntry,
        registryType: action.registryType,
      });
      if (!claims.ok) {
        await this.safeUnlink(dl.value.tempPath);
        failSlot();
        return claims as Result<never>;
      }

      // Extract (activation) — only after every verification passed.
      slots.update(slotId, { state: 'extracting' });
      stream.publish();
      const ex = await this.extractor.extract(action.packageName, dl.value.tempPath, manifestRoot, action.path);
      await this.safeUnlink(dl.value.tempPath);
      if (!ex.ok) {
        failSlot();
        return ex as Result<never>;
      }

      if (action.sizeBytes) slots.addBytesDone(action.sizeBytes);
      slots.update(slotId, { state: 'done' });
      stream.publish();
      slots.release(slotId);
      return ok(undefined);
    } catch (err) {
      failSlot();
      // Fail closed: an unexpected error is a failure, never silent success.
      return this.unexpectedFailure(action.packageName, err);
    }
  }

  private unexpectedFailure(packageName: string, err: unknown): Result<never> {
    const bag = new DiagnosticBag();
    bag.addError(
      'INSTALL_UNEXPECTED_ERROR',
      `Unexpected installer error for "${packageName}": ${err instanceof Error ? err.message : String(err)}`,
      { packageName, reason: String(err) },
    );
    return bag.toFailure();
  }

  private readMaxConcurrent(): number {
    const raw = this.deps.config.get('network.maxConcurrentDownloads');
    return typeof raw === 'number' && raw >= 1 ? Math.floor(raw) : 5;
  }

  private createExecutionRuntime(maxConcurrent: number): ExecutionRuntime {
    const slots = new SlotTable(maxConcurrent);
    const stream = new StatusStream(slots);
    return { slots, stream };
  }

  private readNumber(key: string, fallback: number): number {
    const raw = this.deps.config.get(key);
    return typeof raw === 'number' ? raw : fallback;
  }

  private async safeUnlink(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      /* best-effort */
    }
  }
}
