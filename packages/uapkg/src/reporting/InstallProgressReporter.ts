import { prettyBytes } from '@uapkg/common';
import type { DownloadStatusSnapshot } from '@uapkg/installer';
import type { HeldBackRelease } from '@uapkg/package-manifest';
import { ProcessTextSink, type TextSink } from '#cli/reporting/TextSink.ts';

/**
 * Text-mode progress reporter for `uapkg install / add / update`.
 *
 * Subscribes to the installer's `AsyncIterable<DownloadStatusSnapshot>` and
 * writes a one-line summary whenever the *aggregate totals* change. This keeps
 * output readable even when stdout is piped or captured (no ANSI cursor
 * tricks). Per-slot rows are intentionally omitted in the MVP — the full Ink
 * `InstallProgress` grid is a planned follow-up.
 *
 * At completion, emits a final summary line:
 *   `N added, M updated, X removed, Y unchanged  (B bytes)`
 */
export class InstallProgressReporter {
  private lastBytesDone = -1;
  private lastState = '';

  public constructor(private readonly sink: TextSink = new ProcessTextSink(process.stdout)) {}

  public async consume(stream: AsyncIterable<DownloadStatusSnapshot>): Promise<void> {
    for await (const snapshot of stream) {
      this.renderTick(snapshot);
    }
  }

  private renderTick(snapshot: DownloadStatusSnapshot): void {
    const { totals, slots } = snapshot;
    const active = slots.filter(
      (s) => s.state === 'downloading' || s.state === 'verifying' || s.state === 'extracting' || s.state === 'removing',
    ).length;

    const stateKey = `${active}|${totals.bytesDone}|${totals.bytesTotal}`;
    if (stateKey === this.lastState) return;
    this.lastState = stateKey;

    // Only emit a byte-progress line when bytesTotal is known and has advanced.
    if (totals.bytesTotal > 0 && totals.bytesDone !== this.lastBytesDone) {
      this.lastBytesDone = totals.bytesDone;
      const pct = Math.min(100, Math.floor((totals.bytesDone / totals.bytesTotal) * 100));
      this.sink.writeLine(
        `  installing: ${pct}% (${prettyBytes(totals.bytesDone)} / ${prettyBytes(totals.bytesTotal)}) — ${active} active`,
      );
    }
  }

  /**
   * Emit the post-install one-liner. The caller passes the installer's plan
   * summary directly; this class does not retain it.
   */
  public renderSummary(
    summary: {
      added: number;
      updated: number;
      removed: number;
      unchanged: number;
      totalBytes: number;
    },
    planned = false,
  ): void {
    this.sink.writeLine(
      `${planned ? 'Install plan: ' : ''}${summary.added} added, ${summary.updated} updated, ${summary.removed} removed, ${summary.unchanged} unchanged (${prettyBytes(summary.totalBytes)})`,
    );
  }

  public renderHeldBack(
    releases: readonly HeldBackRelease[],
    minimumReleaseAge: string,
    options: { readonly showEmpty?: boolean; readonly retryCommand?: string } = {},
  ): void {
    if (releases.length === 0) {
      if (options.showEmpty) this.sink.writeLine('0 held back.');
      return;
    }
    this.sink.writeLine(`${releases.length} held back by minimum release age (${minimumReleaseAge}).`);
    for (const release of releases) {
      const remaining = formatRemainingAge(release.eligibleInSeconds);
      const dependency = release.blockedDependency;
      const reason = dependency
        ? `Version ${release.blockedVersion} is held back because ${dependency.name}@${dependency.version} will be eligible in ${remaining}.`
        : `Version ${release.blockedVersion} will be eligible in ${remaining}.`;
      this.sink.writeLine(`  Selected ${release.name}@${release.selectedVersion} from ${release.registry}. ${reason}`);
    }
    if (options.retryCommand) {
      this.sink.writeLine(`Use \`${options.retryCommand}\` to ignore the minimum release age for this command.`);
    }
  }
}

function formatRemainingAge(seconds: number): string {
  let remaining = Math.max(0, Math.ceil(seconds));
  const parts: string[] = [];
  for (const [unit, size] of [
    ['w', 604800],
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ] as const) {
    const amount = Math.floor(remaining / size);
    if (amount > 0) parts.push(`${amount}${unit}`);
    remaining %= size;
  }
  return parts.join(' ') || '0s';
}
