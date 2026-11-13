import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { isSea } from 'node:sea';

export const DEBUG_COLLECTOR_ENV = 'UAPKG_INTERNAL_ENVINFO_COLLECTOR';
const OUTPUT_LIMIT = 128 * 1024;

export interface EnvironmentCollection {
  available: boolean;
  values: unknown;
}

/** Run probes separately so an unavailable or stuck tool cannot block diagnostics. */
export async function collectDebugEnvironment(
  command = {
    executable: process.execPath,
    args: isSea() ? ['--debug-info'] : [path.resolve(process.argv[1]!), '--debug-info'],
  },
  timeout = 10_000,
): Promise<EnvironmentCollection> {
  return await new Promise((resolve) => {
    const environment = { ...process.env };
    // Plain copied objects lose Windows' case-insensitive environment lookup.
    for (const key of Object.keys(environment)) {
      if (['envinfo_debug', 'node_options', 'node_path'].includes(key.toLowerCase())) delete environment[key];
    }
    Object.assign(environment, {
      [DEBUG_COLLECTOR_ENV]: '1',
      COREPACK_ENABLE_NETWORK: '0',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      COREPACK_ENABLE_PROJECT_SPEC: '0',
      COREPACK_ENABLE_AUTO_PIN: '0',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    });
    const child = spawn(command.executable, command.args, {
      cwd: os.tmpdir(),
      env: environment,
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let output = '';
    let settled = false;
    const finish = (result: EnvironmentCollection) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.unref();
      resolve(result);
    };
    const terminate = () => {
      if (child.pid) {
        if (process.platform === 'win32') {
          spawnSync(
            path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'],
            { stdio: 'ignore', timeout: 2_000, windowsHide: true },
          );
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* Already exited. */
          }
        }
      }
      child.kill('SIGKILL');
      finish({ available: false, values: {} });
    };
    const timer = setTimeout(terminate, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > OUTPUT_LIMIT) terminate();
    });
    child.on('error', () => finish({ available: false, values: {} }));
    child.on('close', (status) => {
      if (status !== 0) return finish({ available: false, values: {} });
      try {
        const values: unknown = JSON.parse(output);
        finish({ available: typeof values === 'object' && values !== null, values });
      } catch {
        finish({ available: false, values: {} });
      }
    });
  });
}

/** Only the isolated child enters this mode, after recognizing --debug-info. */
export async function runEnvironmentCollector(): Promise<number> {
  delete process.env.ENVINFO_DEBUG;
  try {
    // The published envinfo build is CommonJS; its named exports are not
    // discoverable by Node's native ESM loader.
    const { default: envinfo } = await import('envinfo');
    const result = await envinfo.run(
      { System: ['OS', 'CPU', 'Memory', 'Shell'], Binaries: ['Node', 'npm', 'pnpm'], Utilities: ['Git'] },
      { json: true, console: false, showNotFound: true },
    );
    process.stdout.write(result);
    return 0;
  } catch {
    return 1;
  }
}
