import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  defineIntegration,
  reconcileIntegration,
  type IntegrationDefinition,
  type IntegrationInput,
} from '../src/index.ts';

let root: string;
const ledger = 'uapkg.integration-ownership.json';
function write(file: string, text: string): void {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}
function read(file: string): string {
  return fs.readFileSync(path.join(root, file), 'utf8');
}
function exists(file: string): boolean {
  return fs.existsSync(path.join(root, file));
}
function run(input: Partial<IntegrationInput> = {}) {
  return reconcileIntegration({
    workspaceRoot: root,
    workspaceKind: 'project',
    integrations: [],
    directPlugins: [],
    complete: true,
    ...input,
  });
}
function host(definition: IntegrationDefinition, owner = 'integration/public/pkg') {
  return { owner, definition: defineIntegration(definition) };
}
function direct(pluginName: string, owner = 'direct/public/slug') {
  return { owner, pluginName };
}
const project = 'Game.uproject';
const moduleFile = 'Source/Game/Game.Build.cs';
const targetFile = 'Source/GameEditor.Target.cs';
const source = [
  'using UnrealBuildTool;',
  '',
  'public class Game : ModuleRules',
  '{',
  '    public Game(ReadOnlyTargetRules Target) : base(Target)',
  '    {',
  '        // authored',
  '    }',
  '}',
  '',
].join('\r\n');
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'uapkg-integration-test-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('plugin descriptor references', () => {
  it('rejects two distinct installed direct packages claiming one Unreal plugin identity', () => {
    write(project, '{}');
    expect(() => run({ directPlugins: [direct('Native', 'a'), direct('native', 'b')] })).toThrow(/Two direct packages/);
    expect(read(project)).toBe('{}');
  });
  it('retains unrelated descriptor text, number lexemes, property order, BOM and CRLF on round trip', () => {
    const original =
      '\uFEFF{\r\n\t"Comment" : "quote \\" }",\r\n\t"Plugins" : [ { "Optional" : true , "Name" : "Existing" } ],\r\n\t"Version":1e0\r\n}\r\n';
    write(project, original);
    run({ directPlugins: [direct('Existing'), direct('Added')] });
    expect(read(project)).toContain('"Version":1e0');
    expect(read(project)).toContain('"Optional" : true , "Name" : "Existing"');
    run();
    expect(read(project)).toBe(original);
  });
  it('writes only direct native refs in plugin authoring and leaves installed packages and host work alone', () => {
    write('Author.uplugin', '{}');
    write('Plugins/installed-name/UnrealPlugin.uplugin', '{"Plugins":[]}');
    const input = {
      workspaceKind: 'plugin' as const,
      directPlugins: [direct('UnrealPlugin')],
      integrations: [
        host({
          setupProject: { plugins: ['HostOnly'] },
          setupModules: [{ select: 'all', constructorBody: 'return;' }],
        }),
      ],
    };
    run(input);
    expect(JSON.parse(read('Author.uplugin')).Plugins).toEqual([{ Name: 'UnrealPlugin', Enabled: true }]);
    expect(read('Plugins/installed-name/UnrealPlugin.uplugin')).toBe('{"Plugins":[]}');
    expect(run(input).changedFiles).toEqual([]);
    expect(read(ledger)).not.toContain(root);
    expect(() => run({ ...input, directPlugins: [direct('Other', 'another')], workspaceKind: 'project' })).toThrow(
      /root .uproject/,
    );
  });
  it('merges shared owners, preserves pre-existing values and restores missing Enabled', () => {
    write(
      project,
      '{\r\n\t"Description": "Game",\r\n\t"Plugins": [{"Name":"Original","Enabled":true,"Extra":"keep"},{"Name":"Unspecified","Optional":true}]\r\n}\r\n',
    );
    run({
      directPlugins: [direct('Shared'), direct('Original'), direct('Unspecified')],
      integrations: [host({ setupProject: { plugins: ['Shared'] } })],
    });
    expect(read(project)).not.toMatch(/(?<!\r)\n/);
    run({ integrations: [host({ setupProject: { plugins: ['Shared'] } })] });
    const doc = JSON.parse(read(project));
    expect(doc.Plugins).toEqual([
      { Name: 'Original', Enabled: true, Extra: 'keep' },
      { Name: 'Unspecified', Optional: true },
      { Name: 'Shared', Enabled: true },
    ]);
    expect(JSON.parse(read(ledger)).plugins).toHaveLength(1);
    run();
    expect(JSON.parse(read(project)).Plugins).toEqual(doc.Plugins.slice(0, 2));
    expect(exists(ledger)).toBe(false);
  });
  it('preserves explicitly disabled flags and does not apply earlier planned operations', () => {
    const before = '{"Plugins":[{"Name":"Blocked","Enabled":false}]}';
    write(project, before);
    expect(() => run({ directPlugins: [direct('Allowed'), direct('Blocked')] })).toThrow(
      /--- current[\s\S]*"Enabled":false[\s\S]*"Enabled":true/,
    );
    expect(read(project)).toBe(before);
    expect(exists(ledger)).toBe(false);
  });
  it('retains owners in a partial graph and keeps intentionally retained script output', () => {
    write(project, '{}');
    run({ directPlugins: [direct('Direct')], integrations: [host({ setupProject: { plugins: ['Host'] } })] });
    expect(run({ complete: false }).changedFiles).toEqual([]);
    run({ retainOwners: ['integration/public/pkg'] });
    expect(JSON.parse(read(project)).Plugins).toEqual([{ Name: 'Host', Enabled: true }]);
    run();
    expect(JSON.parse(read(project))).toEqual({});
  });
  it('protects metadata added by users to a generated entry until they resolve its removal', () => {
    write(project, '{}');
    run({ directPlugins: [direct('Plugin')] });
    write(project, '{"Plugins":[{"Name":"Plugin","Enabled":true,"Optional":true}]}');
    expect(() => run()).toThrow(/Optional/);
    write(project, '{"Plugins":[]}');
    run();
    expect(exists(ledger)).toBe(false);
  });
});

describe('source edits', () => {
  beforeEach(() => {
    write(project, '{"Modules":[{"Name":"Game","Type":"Runtime"}]}');
    write(moduleFile, source);
    write(
      targetFile,
      'using UnrealBuildTool;\npublic class GameEditorTarget : TargetRules\n{\n    public GameEditorTarget(TargetInfo Target) : base(Target)\n    {\n        Type = TargetType.Editor;\n    }\n}\n',
    );
  });
  it('applies exact modules and explicit all targets with readable markers and stable, reversible bytes', () => {
    const targetBefore = read(targetFile);
    const input = {
      integrations: [
        host({
          setupModules: [
            {
              select: ['Game'],
              includes: 'using System;',
              classBody: 'const int Local = 1;',
              constructorBody: 'PrivateDefinitions.Add("X");',
            },
          ],
          setupTargets: [{ select: 'all', constructorBody: 'GlobalDefinitions.Add("Y");' }],
        }),
      ],
    };
    run(input);
    expect(read(moduleFile)).toContain('// UAPKG-BEGIN integration:constructorBody');
    expect(read(targetFile)).toContain('GlobalDefinitions.Add');
    expect(read(moduleFile)).not.toMatch(/(?<!\r)\n/);
    expect(run(input).changedFiles).toEqual([]);
    run();
    expect(read(moduleFile)).toBe(source);
    expect(read(targetFile)).toBe(targetBefore);
  });
  it('rejects implicit, missing and ambiguous targets before native edits', () => {
    expect(() => run({ integrations: [host({ setupModules: [{ constructorBody: 'return;' }] as never })] })).toThrow();
    const input = {
      directPlugins: [direct('Direct')],
      integrations: [host({ setupModules: [{ select: ['Missing'], constructorBody: 'return;' }] })],
    };
    expect(() => run(input)).toThrow(/Missing/);
    expect(JSON.parse(read(project)).Plugins).toBeUndefined();
    write('Source/Other/Game.Build.cs', source);
    expect(() =>
      run({ integrations: [host({ setupModules: [{ select: 'all', constructorBody: 'return;' }] })] }),
    ).toThrow(/found 2/);
  });
  it('handles a UTF-8 BOM, C# comments and nonstandard constructor parameter names', () => {
    const before = '\uFEFF// class Fake : ModuleRules { }\r\n' + source.replaceAll('Target)', 'targetInfo)');
    write(moduleFile, before);
    const input = {
      integrations: [
        host({ setupModules: [{ select: ['Game'], includes: 'using System;', constructorBody: 'int x = 1;' }] }),
      ],
    };
    run(input);
    expect(run(input).changedFiles).toEqual([]);
    run();
    expect(read(moduleFile)).toBe(before);
  });
  it('rejects a symlinked source root without changing the descriptor or linked source', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'uapkg-linked-test-'));
    try {
      fs.renameSync(path.join(root, 'Source'), path.join(outside, 'Source'));
      fs.symlinkSync(
        path.join(outside, 'Source'),
        path.join(root, 'Source'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      expect(() =>
        run({
          directPlugins: [direct('One')],
          integrations: [host({ setupModules: [{ select: ['Game'], constructorBody: 'return;' }] })],
        }),
      ).toThrow(/traverses a link/);
      expect(JSON.parse(read(project)).Plugins).toBeUndefined();
      expect(read(moduleFile)).toBe(source);
    } finally {
      fs.rmSync(path.join(root, 'Source'), { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
  it('preserves manual drift across unchanged installs, shows a diff on update/removal, recognizes manually applied expected code', () => {
    const body = (code: string) => ({
      integrations: [host({ setupModules: [{ select: ['Game'], constructorBody: code }] })],
    });
    run(body('int x = 1;'));
    const edited = read(moduleFile)
      .replace('int x = 1;', 'int x = 99;')
      .replace('// authored', '// user changed this too');
    write(moduleFile, edited);
    expect(run(body('int x = 1;')).changedFiles).toEqual([]);
    expect(() => run(body('int x = 2;'))).toThrow(/-.*int x = 99;[\s\S]*\+.*int x = 2;/);
    expect(() => run()).toThrow(/\+\(absent\)/);
    expect(read(moduleFile)).toBe(edited);
    write(moduleFile, edited.replace('int x = 99;', 'int x = 2;'));
    expect(run(body('int x = 2;')).changedFiles).toEqual([ledger]);
    run();
    expect(read(moduleFile)).toBe(source.replace('// authored', '// user changed this too'));
  });
  it('deduplicates shared member declarations and retains them until the final owner leaves', () => {
    const def = { setupModules: [{ select: ['Game'], classBody: 'const int same = 1;' }] };
    run({ integrations: [host(def, 'r/a'), host(def, 'r/b')] });
    expect(read(moduleFile).match(/int same/g)).toHaveLength(1);
    expect(run({ integrations: [host(def, 'r/b')] }).changedFiles).toEqual([ledger]);
    run();
    expect(read(moduleFile)).toBe(source);
  });
});

describe('transaction recovery', () => {
  it('preflights a read-only target before applying other writable edits', () => {
    write(project, '{"Modules":[{"Name":"Game"}]}');
    write(moduleFile, source);
    fs.chmodSync(path.join(root, moduleFile), 0o444);
    try {
      expect(() =>
        run({
          directPlugins: [direct('Direct')],
          integrations: [host({ setupModules: [{ select: ['Game'], constructorBody: 'return;' }] })],
        }),
      ).toThrow(/read-only|permission/i);
      expect(read(project)).toBe('{"Modules":[{"Name":"Game"}]}');
      expect(exists(ledger)).toBe(false);
    } finally {
      fs.chmodSync(path.join(root, moduleFile), 0o666);
    }
  });
  it('rolls forward a previously interrupted edit and refuses to overwrite unrelated edits', () => {
    write(project, '{"Before":true}');
    write(moduleFile, 'first');
    const journal = '.uapkg/integration-transaction.json';
    const record = JSON.stringify({
      version: 1,
      pid: 0,
      changes: [
        { file: moduleFile, before: 'before', after: 'first' },
        { file: project, before: '{"Before":true}', after: '{"After":true}' },
      ],
    });
    write(journal, record);
    run();
    expect(read(project)).toBe('{"After":true}');
    expect(exists(journal)).toBe(false);
    write(journal, record);
    write(project, '{"User":true}');
    expect(() => run()).toThrow(/changed during the transaction/);
    expect(read(project)).toBe('{"User":true}');
    expect(exists(journal)).toBe(true);
  });
  it('rejects a journal pointing into an installed package', () => {
    const file = 'Plugins/Child/Child.uplugin';
    write(file, '{}');
    write(
      '.uapkg/integration-transaction.json',
      JSON.stringify({ version: 1, pid: 0, changes: [{ file, before: '{}', after: '{"Changed":true}' }] }),
    );
    expect(() => run()).toThrow(/Invalid integration transaction target/);
    expect(read(file)).toBe('{}');
  });
});
