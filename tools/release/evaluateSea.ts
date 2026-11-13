import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  CLI_ROOT,
  NPM_PACKAGE_ROOT,
  WORKSPACE_ROOT,
  readJson,
  writeJson,
} from '../../packages/uapkg/build/EnginePackage.ts';
import { currentPlatform } from './ReleaseArtifacts.ts';
import { buildSea } from './SeaBuild.ts';
import { smokeEngine } from './Smoke.ts';

/** Reproduce the SEA qualification gate without building the Rust launcher. */
export function evaluateSea(): void {
  if (!existsSync(path.join(NPM_PACKAGE_ROOT, 'node_modules')))
    throw new Error('Run release smoke-npm before the SEA evaluation.');
  const root = path.join(WORKSPACE_ROOT, '.cache/sea-feasibility');
  const engine = path.join(root, 'cli');
  mkdirSync(root, { recursive: true });
  buildSea(NPM_PACKAGE_ROOT, engine, path.join(root, 'sea-smoke'), path.join(root, 'sea-build'));
  writeJson(path.join(engine, 'engine.json'), {
    schemaVersion: 1,
    version: readJson<{ version: string }>(path.join(CLI_ROOT, 'package.json')).version,
    platform: currentPlatform(),
    kind: 'sea',
    executable: process.platform === 'win32' ? 'engine.exe' : 'engine',
    args: [],
  });
  smokeEngine(engine, { native: true, keyring: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    evaluateSea();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
