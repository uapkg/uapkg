import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { classifyBuildChange, SerializedRebuildQueue } from '../DevBuildWatcher.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('development rebuild watcher', () => {
  it('classifies Rust and TypeScript changes while excluding generated files', () => {
    expect(classifyBuildChange('launcher/src/main.rs')).toBe('rust');
    expect(classifyBuildChange('launcher/Cargo.lock')).toBe('rust');
    expect(classifyBuildChange('packages/uapkg/src/commands/InstallCommand.ts')).toBe('typescript');
    for (const name of [
      'launcher/target/development/debug/uapkg.exe',
      'packages/uapkg/dist/cli.js',
      'packages/uapkg/package/package.json',
      'packages/uapkg/node_modules/a/index.js',
      'packages/uapkg/tsconfig.tsbuildinfo',
      'tools/dev-build/.state/snapshot.json',
    ])
      expect(classifyBuildChange(name)).toBeNull();
  });

  it('serializes changes arriving during a rebuild and recovers after a failed build', async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const rebuild = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error('build failed'))
      .mockResolvedValue(undefined);
    const report = vi.fn();
    const queue = new SerializedRebuildQueue(rebuild, report, 1);
    queue.schedule('typescript');
    await vi.advanceTimersByTimeAsync(1);
    queue.schedule('rust');
    await vi.advanceTimersByTimeAsync(1);
    expect(rebuild).toHaveBeenCalledTimes(1);
    finish?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(rebuild).toHaveBeenNthCalledWith(2, { typescript: false, rust: true });
    expect(report).toHaveBeenCalledOnce();
    queue.schedule('typescript');
    queue.schedule('rust');
    await vi.advanceTimersByTimeAsync(1);
    expect(rebuild).toHaveBeenNthCalledWith(3, { typescript: true, rust: true });
    queue.stop();
    queue.schedule('rust');
    await vi.runAllTimersAsync();
    expect(rebuild).toHaveBeenCalledTimes(3);
  });
});
