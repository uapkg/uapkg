import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { CompositionRoot } from '../../src/app/CompositionRoot.ts';
import { UAPKG_BUILD_METADATA } from '../../src/build/BuildMetadata.ts';
import { InitCommand } from '../../src/commands/InitCommand.ts';
import { ProjectContextDetector } from '../../src/prompts/ProjectContextDetector.ts';
import type { PromptService } from '../../src/prompts/PromptService.ts';

const directories: string[] = [];
const prompts = {
  async select() {
    throw new Error('Explicit initialization must not prompt');
  },
  async text() {
    throw new Error('Explicit initialization must not prompt');
  },
} as unknown as PromptService;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('init CLI version pin', () => {
  it.each(['project', 'plugin'] as const)(
    'initializes a %s using the executing engine version only for projects',
    async (kind) => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'uapkg-init-pin-'));
      directories.push(cwd);
      const command = new InitCommand(
        new CompositionRoot({ cwd }),
        { explicitKind: kind, explicitName: 'example' },
        new ProjectContextDetector(),
        prompts,
      );

      expect(await command.execute()).toBe(0);
      const manifest = JSON.parse(await readFile(path.join(cwd, 'uapkg.json'), 'utf8')) as Record<string, unknown>;
      expect(manifest.kind).toBe(kind);
      if (kind === 'project') {
        expect(manifest.uapkgVersion).toBe(UAPKG_BUILD_METADATA.packageVersion);
      } else {
        expect(manifest).not.toHaveProperty('uapkgVersion');
      }
    },
  );
});
