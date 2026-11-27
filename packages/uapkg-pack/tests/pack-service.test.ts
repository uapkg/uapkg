import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extract } from 'tar';
import { describe, expect, it } from 'vite-plus/test';
import { PackService } from '../src/core/PackService.ts';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'uapkg-pack-'));
}

function writeBasicPluginFixture(root: string) {
  fs.writeFileSync(path.join(root, 'uapkg.json'), '{"name":"pkg","version":"1.0.0"}\n', 'utf8');
  fs.writeFileSync(
    path.join(root, 'Plugin.uplugin'),
    '{"FileVersion":3,"Version":1,"FriendlyName":"Plugin"}\n',
    'utf8',
  );
  fs.writeFileSync(path.join(root, 'file.txt'), 'hello\n', 'utf8');
}

describe('PackService', () => {
  it('ships an explicit override and imported helpers under one prefix for a scoped release', async () => {
    const root = createTempDir(),
      unpacked = createTempDir();
    try {
      writeBasicPluginFixture(root);
      fs.mkdirSync(path.join(root, '.uapkg/author'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'uapkg.json'),
        JSON.stringify({
          name: '@scope/tool',
          version: '1.0.0',
          integration: { entry: '.uapkg/author/entry.mjs' },
        }),
      );
      fs.writeFileSync(path.join(root, '.uapkg/integration.js'), 'throw new Error("inactive conventional entry")');
      fs.writeFileSync(path.join(root, '.uapkg/integration.ts'), 'not valid TypeScript (');
      fs.writeFileSync(path.join(root, '.uapkg/author/helper.ts'), 'export const number: number = 7;');
      fs.writeFileSync(
        path.join(root, '.uapkg/author/entry.mjs'),
        "import {number} from './helper.ts'; export default {number};",
      );
      const result = await new PackService().pack({ cwd: root });
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      if (!result.ok) return;
      await extract({ file: result.value.archivePath, cwd: unpacked, strip: 1 });
      expect(JSON.parse(fs.readFileSync(path.join(unpacked, 'uapkg.json'), 'utf8')).name).toBe('@scope/tool');
      expect(fs.readdirSync(path.join(unpacked, '.uapkg/author')).sort()).toEqual(['entry.mjs', 'helper.ts']);
      expect(fs.existsSync(path.join(unpacked, '.uapkg/integration.ts'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(unpacked, { recursive: true, force: true });
    }
  });
  it('provisions an explicit runtime only for an executing prepack, and reports a failed prepack before writing', async () => {
    const root = createTempDir();
    try {
      writeBasicPluginFixture(root);
      fs.writeFileSync(
        path.join(root, 'uapkg.json'),
        JSON.stringify({
          name: 'pkg',
          version: '1.0.0',
          lifecycle: { runtime: { node: '22' }, scripts: { prepack: 'prepare.mjs' } },
        }),
      );
      fs.writeFileSync(
        path.join(root, 'prepare.mjs'),
        "export default () => { throw new Error('cannot prepare fixture'); };",
      );
      const resolved: string[] = [];
      const options = {
        cwd: root,
        resolveNode: async (selector: string, cwd: string) => {
          expect(cwd).toBe(root);
          resolved.push(selector);
          return process.execPath;
        },
      };
      expect((await new PackService().pack({ ...options, dryRun: true })).ok).toBe(true);
      expect((await new PackService().pack({ ...options, ignoreScripts: true })).ok).toBe(true);
      expect(resolved).toEqual([]);
      const output = path.join(root, 'failed-package.tgz');
      const failed = await new PackService().pack({ ...options, outFile: output });
      expect(failed.ok).toBe(false);
      expect(failed.diagnostics[0].message).toContain('cannot prepare fixture');
      expect(fs.existsSync(output)).toBe(false);
      expect(resolved).toEqual(['22']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('runs prepack before selection, ships lifecycle helpers and excludes dependencies and ownership records', async () => {
    const root = createTempDir();
    try {
      writeBasicPluginFixture(root);
      fs.mkdirSync(path.join(root, '.uapkg/lifecycle'), { recursive: true });
      fs.mkdirSync(path.join(root, 'Plugins/nested'), { recursive: true });
      fs.writeFileSync(path.join(root, 'uapkg.lock'), JSON.stringify({ packages: { nested: {} } }));
      fs.writeFileSync(path.join(root, 'Plugins/nested/Nested.uplugin'), '{}');
      fs.writeFileSync(path.join(root, 'uapkg.integration-ownership.json'), '{}');
      fs.writeFileSync(path.join(root, '.uapkg/config.json'), '{}');
      fs.writeFileSync(path.join(root, '.uapkg/helper.ts'), 'export const value: number = 3;');
      fs.writeFileSync(
        path.join(root, '.uapkg/integration.mjs'),
        "import {value} from './helper.ts'; export default {value};",
      );
      fs.writeFileSync(
        path.join(root, '.uapkg/lifecycle/prepack.ts'),
        "import fs from 'node:fs'; export default () => fs.appendFileSync('generated.txt','x');",
      );
      const preview = await new PackService().pack({ cwd: root, dryRun: true });
      expect(preview.ok).toBe(true);
      expect(fs.existsSync(path.join(root, 'generated.txt'))).toBe(false);
      const result = await new PackService().pack({ cwd: root });
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      if (!result.ok) return;
      expect(result.value.files).toEqual(
        expect.arrayContaining(['.uapkg/helper.ts', '.uapkg/integration.mjs', 'generated.txt']),
      );
      expect(result.value.files).not.toContain('Plugins/nested/Nested.uplugin');
      expect(result.value.files).not.toContain('uapkg.integration-ownership.json');
      expect(result.value.files).not.toContain('.uapkg/config.json');
      expect(fs.readFileSync(path.join(root, 'generated.txt'), 'utf8')).toBe('x');
      fs.unlinkSync(path.join(root, 'Plugin.uplugin'));
      expect((await new PackService().pack({ cwd: root, dryRun: true })).ok).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('creates archive and integrity file', async () => {
    const root = createTempDir();
    writeBasicPluginFixture(root);

    const result = await new PackService().pack({ cwd: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fs.existsSync(result.value.archivePath)).toBe(true);
    expect(result.value.integrityPath).toBeDefined();
    expect(result.value.integrityPath ? fs.existsSync(result.value.integrityPath) : false).toBe(true);
    expect(result.value.files).toContain('uapkg.json');
    expect(result.value.files).toContain('file.txt');
  });

  it('supports dry-run without writing archive', async () => {
    const root = createTempDir();
    writeBasicPluginFixture(root);

    const outFile = 'custom.tgz';
    const result = await new PackService().pack({ cwd: root, dryRun: true, outFile });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dryRun).toBe(true);
    expect(fs.existsSync(path.join(root, outFile))).toBe(false);
  });
});
