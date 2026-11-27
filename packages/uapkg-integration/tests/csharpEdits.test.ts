import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { reconcileIntegration, type SourceEdit } from '../src/index.ts';

const authored =
  'public class GameTarget : UnrealBuildTool.TargetRules { public GameTarget(UnrealBuildTool.TargetInfo target) : base(target) { } }\r\n';
const file = 'Source/Game.Target.cs';
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'uapkg-csharp-edits-'));
  fs.mkdirSync(path.join(root, 'Source'));
  fs.writeFileSync(path.join(root, 'Game.uproject'), '{}');
  write(authored);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(code: string) {
  fs.writeFileSync(path.join(root, file), code);
}
function read() {
  return fs.readFileSync(path.join(root, file), 'utf8');
}
function install(owners: Record<string, Omit<SourceEdit, 'select'>[]>) {
  return reconcileIntegration({
    workspaceKind: 'project',
    workspaceRoot: root,
    complete: true,
    directPlugins: [],
    integrations: Object.entries(owners).map(([owner, edits]) => ({
      owner,
      definition: { setupTargets: edits.map((edit) => ({ ...edit, select: ['Game'] })) },
    })),
  });
}

describe('C# source integration', () => {
  it('keeps each package’s statements together in its own block, including identical statements', () => {
    const statements = [
      { constructorBody: 'var setting = "shared";' },
      { constructorBody: 'GlobalDefinitions.Add(setting);' },
    ];
    install({ second: statements, first: statements });
    const scope = /\{\r\n[ \t]+var setting = "shared";\r\n[ \t]+GlobalDefinitions\.Add\(setting\);\r\n[ \t]+\}/g;
    expect(read().match(scope)).toHaveLength(2);
    expect(read()).not.toMatch(/(?<!\r)\n/);
    expect(install({ first: statements, second: statements }).changedFiles).toEqual([]);
    install({ second: statements });
    expect(read().match(scope)).toHaveLength(1);
    install({});
    expect(read()).toBe(authored);
  });

  it('keeps leading whitespace inside multiline literals when indenting constructor snippets', () => {
    const code = [
      'string a = @"first',
      ' second";',
      'string b = $@"first',
      ' third {a}";',
      'string c = """',
      '    raw',
      '    """;',
    ].join('\n');
    install({ owner: [{ constructorBody: code }] });
    expect(read()).toContain('@"first\r\n second";');
    expect(read()).toContain('$@"first\r\n third {a}";');
    expect(read()).toContain('"""\r\n    raw\r\n    """;');
    install({});
    expect(read()).toBe(authored);
  });

  it('preserves disabled text in fragments and checks the active constructor statements', () => {
    const conditional = '#if false\nignored C# text }\n#else\nint setting = 1;\n#endif';
    install({ owner: [{ constructorBody: conditional }] });
    expect(read()).toContain('ignored C# text }');
    expect(read()).toContain('int setting = 1;');
    expect(install({ owner: [{ constructorBody: conditional }] }).changedFiles).toEqual([]);
    install({});
    expect(read()).toBe(authored);
  });

  it('sorts contributions by C# using order and keeps directive comments and conditional branches together', () => {
    const input = {
      first: [{ includes: 'using System.IO; // local I/O\n// text types\nglobal using System.Text;' }],
      second: [{ includes: '#if BUILD_FEATURE\nglobal using X;\n#else\nglobal using Y;\n#endif\nusing Z;' }],
    };
    const original = '\uFEFFextern alias Engine;\r\nglobal using Host.Types;\r\nusing UnrealBuildTool;\r\n' + authored;
    write(original);
    install(input);
    expect(read()).toContain(
      '// text types\r\nglobal using System.Text;\r\n#if BUILD_FEATURE\r\nglobal using X;\r\n#else\r\nglobal using Y;\r\n#endif\r\nusing System.IO; // local I/O\r\nusing Z;',
    );
    expect(read().indexOf('global using Host.Types')).toBeLessThan(read().indexOf('// text types'));
    expect(read().indexOf('using Z;')).toBeLessThan(read().indexOf('using UnrealBuildTool;'));
    expect(install(input).changedFiles).toEqual([]);
    install({});
    expect(read()).toBe(original);
  });

  it('rejects ambiguous conditional imports, declarations passed as imports, and fragments escaping their C# scope', () => {
    expect(() => install({ owner: [{ includes: '#if X\nglobal using A;\n#else\nusing B;\n#endif' }] })).toThrow(
      /conditional global/i,
    );
    expect(() => install({ owner: [{ includes: 'class Extra {}' }] })).toThrow(/using directives/);
    expect(() => install({ owner: [{ constructorBody: '} void Escaped() {' }] })).toThrow(/constructorBody/);
    expect(() => install({ owner: [{ classBody: '} class Escaped {' }] })).toThrow(/classBody/);
    expect(read()).toBe(authored);
  });

  it('ignores marker-shaped lines inside C# literals and multiline comments', () => {
    const lookalikes = '// UAPKG-BEGIN integration:constructorBody\n// UAPKG-END integration:constructorBody';
    const original = [
      '/*',
      lookalikes,
      '*/',
      'using UnrealBuildTool;',
      'public class GameTarget : TargetRules {',
      'const string RawText = """',
      lookalikes,
      '""";',
      'const string VerbatimText = @"',
      lookalikes,
      '";',
      'public GameTarget(TargetInfo target) : base(target) { }',
      '}',
    ].join('\n');
    write(original);
    const input = { owner: [{ constructorBody: 'int n = 1;' }] };
    install(input);
    expect(install(input).changedFiles).toEqual([]);
    install({});
    expect(read()).toBe(original);
  });

  it('preserves a previously owned block that has been moved into disabled code', () => {
    install({ owner: [{ constructorBody: 'int n = 1;' }] });
    const disabled = read()
      .replace('// UAPKG-BEGIN', '#if false\r\n// UAPKG-BEGIN')
      .replace('// UAPKG-END integration:constructorBody', '// UAPKG-END integration:constructorBody\r\n#endif');
    write(disabled);
    expect(() => install({ owner: [{ constructorBody: 'int n = 2;' }] })).toThrow(/disabled|conditionally compiled/);
    expect(() => install({})).toThrow(/disabled|conditionally compiled/);
    expect(read()).toBe(disabled);
  });

  it('shows the diff and preserves a hand-edited block containing a syntax error', () => {
    install({ owner: [{ constructorBody: 'int n = 1;' }] });
    const edited = read().replace('int n = 1;', 'int n = ;');
    write(edited);
    expect(() => install({ owner: [{ constructorBody: 'int n = 2;' }] })).toThrow(/-.*int n = ;[\s\S]*\+.*int n = 2;/);
    expect(read()).toBe(edited);
  });
});
