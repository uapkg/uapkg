import type { DownloadStatusSnapshot } from '@uapkg/installer';
import { describe, expect, it } from 'vite-plus/test';
import { InstallProgressReporter } from '../../src/reporting/InstallProgressReporter.ts';
import { MemoryTextSink } from '../_fakes/MemoryTextSink.ts';

function snap(bytesDone: number, bytesTotal: number, activeSlots = 1): DownloadStatusSnapshot {
  return {
    slots: Array.from({ length: activeSlots }, (_, i) => ({
      slotId: i,
      state: 'downloading' as const,
      bytesDone: 0,
      attempt: 1,
    })),
    totals: {
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      bytesDone,
      bytesTotal,
    },
  };
}

async function* iter(...snaps: DownloadStatusSnapshot[]): AsyncIterable<DownloadStatusSnapshot> {
  for (const s of snaps) yield s;
}

describe('InstallProgressReporter', () => {
  it('emits a progress line when bytesDone advances', async () => {
    const sink = new MemoryTextSink();
    const reporter = new InstallProgressReporter(sink);
    await reporter.consume(iter(snap(10, 100), snap(50, 100), snap(100, 100)));
    expect(sink.lines.length).toBeGreaterThanOrEqual(1);
    expect(sink.lines.every((l) => l.includes('installing'))).toBe(true);
  });

  it('dedups identical ticks (no duplicate lines when state unchanged)', async () => {
    const sink = new MemoryTextSink();
    const reporter = new InstallProgressReporter(sink);
    await reporter.consume(iter(snap(10, 100), snap(10, 100), snap(10, 100)));
    expect(sink.lines.length).toBe(1);
  });

  it('emits no lines when bytesTotal is unknown (0)', async () => {
    const sink = new MemoryTextSink();
    const reporter = new InstallProgressReporter(sink);
    await reporter.consume(iter(snap(10, 0)));
    expect(sink.lines.length).toBe(0);
  });

  it('renderSummary prints plan summary', () => {
    const sink = new MemoryTextSink();
    const reporter = new InstallProgressReporter(sink);
    reporter.renderSummary({ added: 1, updated: 2, removed: 3, unchanged: 4, totalBytes: 1024 });
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toMatch(/1 added, 2 updated, 3 removed, 4 unchanged/);
  });

  it('reports held-back releases with remaining duration and an optional dependency blocker', () => {
    const sink = new MemoryTextSink();
    new InstallProgressReporter(sink).renderHeldBack(
      [
        {
          name: 'example',
          registry: 'official',
          selectedVersion: '1.0.0',
          blockedVersion: '1.1.0',
          publishedAt: 100,
          eligibleInSeconds: 90061,
          blockedDependency: { name: 'child', version: '2.0.0' },
        },
      ],
      '3d',
      { retryCommand: 'uapkg update example --ignore-release-age' },
    );
    expect(sink.joined()).toContain('1 held back by minimum release age (3d)');
    expect(sink.joined()).toContain('1d 1h 1m 1s');
    expect(sink.joined()).toContain('waiting for child@2.0.0');
    expect(sink.joined()).toContain('uapkg update example --ignore-release-age');
  });

  it('explicitly reports an empty update hold count without an unnecessary retry tip', () => {
    const sink = new MemoryTextSink();
    new InstallProgressReporter(sink).renderHeldBack([], '3d', {
      showEmpty: true,
      retryCommand: 'uapkg update --ignore-release-age',
    });
    expect(sink.lines).toEqual(['0 held back.']);
  });
});
