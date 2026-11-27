import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vite-plus/test';
import { reconcileIntegration, type SourceEdit } from '../src/index.ts';

let root: string;
const file = 'Source/GameEOS.Target.cs';
function write(name: string, source: string) {
  const full = path.join(root, name);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, source);
}
function target(parent: string, imports = '') {
  return `using UnrealBuildTool;\n${imports}\npublic class GameEOSTarget : ${parent} {
    public GameEOSTarget(TargetInfo info) : base(info) {}
}\n`;
}
function apply(fields: Omit<SourceEdit, 'select'> = { constructorBody: 'int local = 1;' }) {
  return reconcileIntegration({
    workspaceRoot: root,
    workspaceKind: 'project',
    complete: true,
    installedRoots: ['Source/Installed'],
    directPlugins: [{ owner: 'direct', pluginName: 'Native' }],
    integrations: [{ owner: 'package', definition: { setupTargets: [{ select: ['GameEOS'], ...fields }] } }],
  });
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'uapkg-rules-catalog-'));
  write('Game.uproject', '{}');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('follows qualified, imported and aliased parent types across workspace C# files', () => {
  write('Source/Base.cs', 'namespace Rules { public class Root : global::UnrealBuildTool.TargetRules {} }');
  write('Source/Intermediate.cs', 'using Rules; namespace Variants { public class Intermediate : Root {} }');
  write(file, target('Custom.Intermediate', 'using Custom = global::Variants;'));
  expect(apply().changedFiles).toContain(file);
  expect(apply().changedFiles).toEqual([]);
});

it('resolves a workspace global using when the base class is declared in an imported namespace', () => {
  write('Source/Imports.cs', 'global using Rules;');
  write('Source/Base.cs', 'namespace Rules; public class GameBase : global::UnrealBuildTool.TargetRules {}');
  write(file, target('GameBase'));
  expect(apply().changedFiles).toContain(file);
});

it('resolves a split partial rules class and a globally aliased constructor parameter', () => {
  write('Source/ParentPart.cs', 'public partial class GameEOSTarget : global::UnrealBuildTool.TargetRules {}');
  write('Source/Imports.cs', 'global using Input = global::UnrealBuildTool.TargetInfo;');
  write(file, 'public partial class GameEOSTarget { public GameEOSTarget(Input info) : base(info) {} }\n');
  expect(apply().changedFiles).toContain(file);
  expect(apply().changedFiles).toEqual([]);
});

it('rejects constructor type aliases that change between build configurations', () => {
  write(
    'Source/Imports.cs',
    '#if MOBILE\nglobal using Input = UnrealBuildTool.TargetInfo;\n#else\nglobal using Input = System.Object;\n#endif',
  );
  const original = target('TargetRules').replace('TargetInfo info', 'Input info');
  write(file, original);
  expect(() => apply()).toThrow(/alias|conditional/);
  expect(readFileSync(path.join(root, file), 'utf8')).toBe(original);
});

it.each(['unrelated', 'installed', 'cycle', 'ambiguity', 'conditional', 'shadowed built-in'])(
  'rejects an unproven rules class (%s) before writing either source or descriptor',
  (kind) => {
    let derived = target('Parent');
    switch (kind) {
      case 'unrelated':
        write('Source/Base.cs', 'public class Parent : System.Object {}');
        break;
      case 'installed':
        write('Source/Installed/Hidden.cs', 'public class Parent : global::UnrealBuildTool.TargetRules {}');
        break;
      case 'cycle':
        write('Source/Base.cs', 'public class Parent : Other {} public class Other : Parent {}');
        break;
      case 'ambiguity':
        derived = target('Parent', 'using A; using B;');
        write(
          'Source/Base.cs',
          'namespace A { class Parent : UnrealBuildTool.TargetRules {} } namespace B { class Parent {} }',
        );
        break;
      case 'conditional':
        write('Source/Base.cs', '#if WITH_STEAM\nclass Parent : UnrealBuildTool.TargetRules {}\n#endif');
        break;
      case 'shadowed built-in':
        derived = target('TargetRules');
        write('Source/Base.cs', 'public class TargetRules {}');
        break;
    }
    write(file, derived);
    expect(() => apply()).toThrow();
    expect(readFileSync(path.join(root, file), 'utf8')).toBe(derived);
    expect(readFileSync(path.join(root, 'Game.uproject'), 'utf8')).toBe('{}');
  },
);

it('preserves a previously owned constructor block moved into another method', () => {
  const original = target('TargetRules');
  write(file, original);
  apply();
  const generated = readFileSync(path.join(root, file), 'utf8');
  const block = generated.match(
    /^[ \t]*\/\/ UAPKG-BEGIN integration:constructorBody[\s\S]*?\/\/ UAPKG-END integration:constructorBody/m,
  )![0];
  const moved = original.replace(/}\s*$/, '    void Other() {\n' + block + '\n    }\n}\n');
  write(file, moved);
  expect(() => apply()).toThrow(/scope|moved/);
  expect(() => apply({ constructorBody: 'int updated = 2;' })).toThrow(/scope|moved/);
  expect(readFileSync(path.join(root, file), 'utf8')).toBe(moved);
});

it('preflights new global directives when an authored using has moved above the managed block', () => {
  write(file, target('TargetRules'));
  apply({ includes: 'using System;' });
  const moved = 'using System.Text;\n' + readFileSync(path.join(root, file), 'utf8');
  write(file, moved);
  expect(() => apply({ includes: 'global using System;' })).toThrow(/order|global/);
  expect(readFileSync(path.join(root, file), 'utf8')).toBe(moved);
});
