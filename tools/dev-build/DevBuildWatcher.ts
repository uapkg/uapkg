import fs from 'node:fs';
import path from 'node:path';

export interface RebuildChanges {
  typescript: boolean;
  rust: boolean;
}

const ignoredDirectories = new Set([
  'node_modules',
  'dist',
  'target',
  '.git',
  '.state',
  '.cache',
  '.vite',
  '.pnpm-store',
  'coverage',
]);
const rootInputs = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'vite.config.ts',
  'tsconfig.base.json',
  '.node-version',
]);

export function classifyBuildChange(relativePath: string): keyof RebuildChanges | null {
  const parts = relativePath.replaceAll('\\', '/').split('/');
  if (parts.some((part) => ignoredDirectories.has(part)) || relativePath.endsWith('.tsbuildinfo')) return null;
  if (parts[0] === 'packages' && parts[1] === 'uapkg' && parts[2] === 'package') return null;
  if (parts[0] === 'launcher') return /\.(rs|toml|lock)$/.test(relativePath) ? 'rust' : null;
  if (parts[0] === 'packages' || rootInputs.has(parts[0] ?? '')) return 'typescript';
  return null;
}

/** Coalesces file bursts and never overlaps rebuilds or native activation. */
export class SerializedRebuildQueue {
  private pending: RebuildChanges = { typescript: false, rust: false };
  private running = false;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly rebuild: (changes: RebuildChanges) => Promise<void>;
  private readonly reportError: (error: unknown) => void;
  private readonly debounceMs: number;

  constructor(
    rebuild: (changes: RebuildChanges) => Promise<void>,
    reportError: (error: unknown) => void,
    debounceMs = 150,
  ) {
    this.rebuild = rebuild;
    this.reportError = reportError;
    this.debounceMs = debounceMs;
  }

  schedule(kind: keyof RebuildChanges): void {
    if (this.stopped) return;
    this.pending[kind] = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, this.debounceMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async flush(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped && (this.pending.typescript || this.pending.rust)) {
        const changes = this.pending;
        this.pending = { typescript: false, rust: false };
        try {
          await this.rebuild(changes);
        } catch (error) {
          this.reportError(error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

export async function watchDevelopmentSources(
  workspaceRoot: string,
  rebuild: (changes: RebuildChanges) => Promise<void>,
): Promise<void> {
  const queue = new SerializedRebuildQueue(rebuild, (error) => {
    console.error(`[dev-build] Rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  const watchers: fs.FSWatcher[] = [];
  const register = (directory: string, recursive: boolean, prefix: string) => {
    watchers.push(
      fs.watch(directory, { recursive }, (_event, filename) => {
        if (!filename) return;
        const kind = classifyBuildChange(prefix ? `${prefix}/${filename.toString()}` : filename.toString());
        if (kind) queue.schedule(kind);
      }),
    );
  };
  try {
    register(workspaceRoot, false, '');
    register(path.join(workspaceRoot, 'packages'), true, 'packages');
    register(path.join(workspaceRoot, 'launcher'), true, 'launcher');
    console.log('[dev-build] Watching TypeScript packages and Rust launcher sources. Press Ctrl+C to stop.');
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        cleanup();
        resolve();
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        for (const watcher of watchers) watcher.off('error', fail);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      for (const watcher of watchers) watcher.once('error', fail);
    });
  } finally {
    queue.stop();
    for (const watcher of watchers) watcher.close();
  }
}
