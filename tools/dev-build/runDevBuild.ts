import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDevBuildOptions } from './DevBuildOptions.ts';
import { DevBuildOrchestrator } from './DevBuildOrchestrator.ts';
import type { DevBuildMode } from './types.ts';

function resolveWorkspaceRoot() {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), '..', '..');
}

function normalizeMode(rawMode: string | undefined): DevBuildMode {
  if (!rawMode || rawMode === 'build') {
    return 'build';
  }

  if (rawMode === 'link') {
    return 'link';
  }

  if (rawMode === 'watch') {
    return 'watch';
  }

  if (rawMode === 'unlink') {
    return 'unlink';
  }

  if (rawMode === 'status') {
    return 'status';
  }

  if (rawMode === 'clean') {
    return 'clean';
  }

  if (rawMode === 'cleanAll') {
    return 'cleanAll';
  }

  throw new Error(`[dev-build] Unsupported mode: ${rawMode}`);
}

const mode = normalizeMode(process.argv[2]);
const options = parseDevBuildOptions(mode, process.argv.slice(3));
const orchestrator = new DevBuildOrchestrator(resolveWorkspaceRoot());

if (mode === 'build') {
  console.log(`[dev-build] Starting build in ${options.buildMode ?? 'development'} mode...`);
  orchestrator.buildAll(options.buildMode ?? 'development');
} else if (mode === 'link') {
  orchestrator.link(options);
} else if (mode === 'watch') {
  await orchestrator.watch();
} else if (mode === 'unlink') {
  orchestrator.unlink();
} else if (mode === 'status') {
  orchestrator.status();
} else if (mode === 'clean') {
  orchestrator.clean();
} else if (mode === 'cleanAll') {
  orchestrator.cleanAll();
}
