import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { reconcileIntegration, type IntegrationInput } from '../src/index.ts';
import { dotnet, hasCSharpCompiler, writeProject } from './fixtures/csharpCompiler.ts';

const derived =
  '\uFEFF' +
  `// 🚀 Rules for a project-specific runtime variant
extern alias External;
global using System;
using UnrealBuildTool;
using Input = global::UnrealBuildTool.TargetInfo;

namespace Example;

internal static class Notes
{
    public const string Text = """
        // 🌎 public class PlatformTarget : TargetRules {
        public PlatformTarget(TargetInfo t) : base(t) { }
        """;
}

public sealed class PlatformTarget : SharedGameTarget
{
#if false
    public PlatformTarget(TargetInfo decoy) : base(decoy) { Events.Add("disabled"); }
#else
    public PlatformTarget([System.Diagnostics.CodeAnalysis.AllowNull] Input active) : base(active)
    {
#if OPTIONAL_HOST_SETTING
        Events.Add("optional");
#endif
        Events.Add("authored");
    }
#endif
}
`.replaceAll('\n', '\r\n');

const parent = `using UnrealBuildTool;
namespace Example;
public class SharedGameTarget : TargetRules
{
    public SharedGameTarget(TargetInfo info) : base(info) { }
}
`;

const contributions = ['alpha', 'beta'].map((owner) => ({
  owner,
  definition: {
    setupTargets: [
      {
        select: ['Platform'],
        includes: owner === 'alpha' ? 'using System.IO;' : '// plugin import\nglobal using System.Collections;',
        constructorBody: `var setting = "${owner}";\nEvents.Add(setting);`,
      },
    ],
  },
}));

describe('editing Unreal rules through the project integration entry point', () => {
  let root: string;
  let child: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'uapkg-csharp-rules-'));
    mkdirSync(path.join(root, 'Source'));
    writeFileSync(path.join(root, 'Game.uproject'), '{}');
    writeFileSync(path.join(root, 'Source/SharedGame.Target.cs'), parent);
    child = path.join(root, 'Source/Platform.Target.cs');
    writeFileSync(child, derived);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  function run(integrations: IntegrationInput['integrations']) {
    return reconcileIntegration({
      workspaceRoot: root,
      workspaceKind: 'project',
      integrations,
      directPlugins: [],
      complete: true,
    });
  }

  it('orders extern, global and ordinary imports and scopes constructor code in the live derived class', () => {
    run(contributions);
    const result = readFileSync(child, 'utf8');
    const addedImport = result.indexOf('using System.IO;');
    const addedGlobal = result.indexOf('global using System.Collections;');
    expect(addedGlobal).toBeGreaterThan(result.indexOf('extern alias External;'));
    expect(addedGlobal).toBeLessThan(addedImport);
    expect(addedGlobal).toBeLessThan(result.indexOf('using UnrealBuildTool;'));
    expect(addedImport).toBeGreaterThan(result.indexOf('global using System;'));
    expect(addedImport).toBeGreaterThan(result.indexOf('extern alias External;'));
    expect(addedImport).toBeLessThan(result.indexOf('namespace Example;'));
    expect(result).toContain(
      '#if false\r\n    public PlatformTarget(TargetInfo decoy) : base(decoy) { Events.Add("disabled"); }\r\n#else',
    );
    const active = result.indexOf(': base(active)');
    for (const owner of ['alpha', 'beta']) {
      const statement = result.indexOf(`var setting = "${owner}";`);
      expect(statement).toBeGreaterThan(active);
      expect(statement).toBeLessThan(result.indexOf('Events.Add("authored")'));
    }
    expect(result.charCodeAt(0)).toBe(0xfeff);
    expect(result).not.toMatch(/(?<!\r)\n/);
    expect(run(contributions).changedFiles).toEqual([]);
    run([]);
    expect(readFileSync(child, 'utf8')).toBe(derived);
  });

  it('preflights unresolved conditional constructors without partially applying other changes', () => {
    const unknown = derived.replace('#if false', '#if WITH_PROJECT_SDK');
    writeFileSync(child, unknown);
    expect(() =>
      run([
        {
          owner: 'pkg',
          definition: {
            setupProject: { plugins: ['Native'] },
            setupTargets: [{ select: ['Platform'], constructorBody: 'Events.Add("pkg");' }],
          },
        },
      ]),
    ).toThrow();
    expect(readFileSync(child, 'utf8')).toBe(unknown);
    expect(readFileSync(path.join(root, 'Game.uproject'), 'utf8')).toBe('{}');
    expect(existsSync(path.join(root, 'uapkg.integration-ownership.json'))).toBe(false);
  });

  it('follows file-local symbols through #elif and ignores non-C# text in a disabled branch', () => {
    const program = `#define ACTIVE_VARIANT
#undef OTHER_VARIANT
using UnrealBuildTool;
public class PlatformTarget : TargetRules
{
#if false || !ACTIVE_VARIANT
    this disabled text does not need to be valid C#
#elif ACTIVE_VARIANT && !OTHER_VARIANT
    public PlatformTarget(TargetInfo live) : base(live) { }
#else
    public PlatformTarget(TargetInfo dead) : base(dead) { }
#endif
}
`;
    writeFileSync(child, program);
    run(contributions);
    const edited = readFileSync(child, 'utf8');
    expect(edited.indexOf('using System.IO;')).toBeGreaterThan(edited.indexOf('#undef OTHER_VARIANT'));
    expect(edited.indexOf('var setting = "alpha";')).toBeGreaterThan(edited.indexOf(': base(live)'));
    expect(edited.indexOf('var setting = "beta";')).toBeLessThan(edited.indexOf('#else'));
    expect(edited).toContain('public PlatformTarget(TargetInfo dead) : base(dead) { }');
    run([]);
    expect(readFileSync(child, 'utf8')).toBe(program);
  });

  it.skipIf(!hasCSharpCompiler)(
    'compiles and executes the derived active constructor and both independently named locals',
    () => {
      writeFileSync(
        path.join(root, 'UnrealTypes.cs'),
        `namespace UnrealBuildTool;
      public sealed class TargetInfo { }
      public class TargetRules {
          public System.Collections.Generic.List<string> Events { get; } = new();
          public TargetRules(TargetInfo info) { }
      }`,
      );
      writeFileSync(
        path.join(root, 'Program.cs'),
        `Console.WriteLine(string.Join(",", new Example.PlatformTarget(new UnrealBuildTool.TargetInfo()).Events));`,
      );
      // An explicit aliased assembly reference makes the existing extern alias meaningful to Roslyn.
      writeProject(
        root,
        '<Compile Include="UnrealTypes.cs;Program.cs"/><Reference Include="Microsoft.Build.Framework"><HintPath>$(MSBuildToolsPath)/Microsoft.Build.Framework.dll</HintPath><Aliases>External</Aliases><Private>false</Private></Reference>',
        'Exe',
      );
      const execute = (...properties: string[]) =>
        dotnet(root, ['run', '--project', 'Qualification.csproj', '-p:NuGetAudit=false', ...properties])
          .trim()
          .split(/\r?\n/)
          .at(-1);
      expect(execute()).toBe('authored');
      run(contributions);
      expect(execute()).toBe('alpha,beta,authored');
      expect(execute('-p:DefineConstants=OPTIONAL_HOST_SETTING')).toBe('alpha,beta,optional,authored');
    },
    100_000,
  );
});
