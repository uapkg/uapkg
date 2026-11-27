import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isSea } from 'node:sea';
import { pathToFileURL } from 'node:url';
import { prepareLifecycleEntry } from '#lifecycle/bundle.ts';
import type { LifecycleKind } from '#lifecycle/entries.ts';

export interface LifecycleContext {
  packageRoot: string;
  workspaceRoot: string;
  workDir: string;
}

export interface RunLifecycleEntryOptions extends LifecycleContext {
  kind: LifecycleKind;
  entry: string;
  nodeExecutable?: string;
}

// This launcher is written beside the compiled entry. Pinned Node, development Node and
// the embedded release runtime all import the same two files and receive the same context.
const workerSource = `import fs from 'node:fs/promises';
const request = JSON.parse(await fs.readFile(new URL('./request.json', import.meta.url), 'utf8'));
const { default: entry } = await import('./entry.mjs');
let result = null;
if (request.kind === 'integration') {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('An integration entry must export a definition object.');
  result = entry;
} else {
  if (typeof entry !== 'function') throw new Error('A lifecycle script must export a default function.');
  await entry(request.context);
}
await fs.writeFile(new URL('./result.json', import.meta.url), JSON.stringify(result));
`;

export async function runLifecycleEntry(options: RunLifecycleEntryOptions): Promise<unknown> {
  const context = {
    packageRoot: path.resolve(options.packageRoot),
    workspaceRoot: path.resolve(options.workspaceRoot),
    workDir: path.resolve(options.workDir),
  };
  const { code } = await prepareLifecycleEntry(context.packageRoot, options.entry);
  await fs.mkdir(context.workDir, { recursive: true });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'uapkg-lifecycle-'));
  try {
    const bootstrap = path.join(directory, 'worker.mjs');
    await fs.writeFile(path.join(directory, 'entry.mjs'), code);
    await fs.writeFile(bootstrap, workerSource);
    await fs.writeFile(path.join(directory, 'request.json'), JSON.stringify({ kind: options.kind, context }));
    const embedded = !options.nodeExecutable && isSea();
    const args = embedded ? ['--internal-lifecycle-worker'] : [bootstrap];
    const executable = options.nodeExecutable || process.execPath;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: options.kind === 'prepack' ? context.packageRoot : context.workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let output = '';
      const capture = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-16_384);
      };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      child.stdin.on('error', () => {
        /* close/error below reports a failed child */
      });
      child.on('error', reject);
      child.on('close', (status, signal) => {
        if (status === 0) resolve();
        else
          reject(
            new Error(options.kind + ' failed (' + (signal || status) + ')' + (output ? ': ' + output.trim() : '.')),
          );
      });
      child.stdin.end(embedded ? JSON.stringify(bootstrap) : undefined);
    });
    const output = await fs.readFile(path.join(directory, 'result.json'), 'utf8');
    return JSON.parse(output);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** CLI private mode for SEA builds, where process.execPath cannot launch a plain Node script. */
export async function runLifecycleWorker(): Promise<number> {
  try {
    let message = '';
    for await (const chunk of process.stdin) {
      message += chunk.toString();
      if (message.length > 65_536) throw new Error('Lifecycle worker request exceeds the limit.');
    }
    const file: unknown = JSON.parse(message);
    if (
      typeof file !== 'string' ||
      !path.isAbsolute(file) ||
      path.basename(file) !== 'worker.mjs' ||
      path.dirname(path.dirname(file)) !== path.resolve(os.tmpdir()) ||
      !path.basename(path.dirname(file)).startsWith('uapkg-lifecycle-') ||
      (await fs.readFile(file, 'utf8')) !== workerSource
    ) {
      throw new Error('Invalid lifecycle worker request.');
    }
    await import(pathToFileURL(file).href);
    return 0;
  } catch (error) {
    process.stderr.write(String(error) + '\n');
    return 1;
  }
}
