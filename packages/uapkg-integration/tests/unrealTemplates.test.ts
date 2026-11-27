import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vite-plus/test';
import { reconcileIntegration, type IntegrationInput, type SourceEdit } from '../src/index.ts';
import { dotnet, hasCSharpCompiler, writeProject } from './fixtures/csharpCompiler.ts';

// Set this to the directory containing Engine, Templates and Samples to run release qualification.
const engine = process.env.UAPKG_UNREAL_ENGINE_ROOT;

it.skipIf(!engine)(
  'edits, compiles and restores the installed Unreal template and sample rules',
  () => {
    if (!hasCSharpCompiler) throw new Error('Unreal rules qualification requires a .NET SDK 8 or later.');
    const root = mkdtempSync(path.join(tmpdir(), 'uapkg-unreal-rules-'));
    try {
      const originals = new Map<string, Buffer>();
      const modules: { Name: string }[] = [];
      const counts: Record<string, number> = {};
      for (const section of ['Templates', 'Samples']) {
        const directory = path.join(engine!, section);
        const entries = readdirSync(directory, { recursive: true, encoding: 'utf8' });
        for (const file of entries) {
          if (!file.split(path.sep).includes('Source') || !/\.(Build|Target)\.cs$/.test(file)) continue;
          // Exercise the public reconciliation path only on a copy, in the writable game's Source directory.
          const relative = path.posix.join('Source', section, ...file.split(path.sep));
          const bytes = readFileSync(path.join(directory, file));
          originals.set(relative, bytes);
          const copy = path.join(root, relative);
          mkdirSync(path.dirname(copy), { recursive: true });
          writeFileSync(copy, bytes);
          if (file.endsWith('.Build.cs')) modules.push({ Name: path.basename(file, '.Build.cs') });
          counts[section] = (counts[section] ?? 0) + 1;
        }
      }
      expect(counts.Templates).toBeGreaterThan(0);
      expect(counts.Samples).toBeGreaterThan(0);
      writeFileSync(path.join(root, 'Qualification.uproject'), JSON.stringify({ Modules: modules }));

      const assemblies = path.join(engine!, 'Engine/Binaries/DotNET/UnrealBuildTool');
      const references = [
        'UnrealBuildTool',
        'EpicGames.Build',
        'EpicGames.Core',
        'Microsoft.Extensions.Logging.Abstractions',
        'Microsoft.Extensions.Logging',
      ];
      writeProject(
        root,
        references
          .map(
            (name) =>
              `<Reference Include="${name}"><HintPath>$(UapkgRulesAssemblies)/${name}.dll</HintPath></Reference>`,
          )
          .join('\n'),
      );
      const compile = () =>
        dotnet(root, ['build', 'Qualification.csproj', '-p:NuGetAudit=false', '--verbosity', 'quiet'], {
          UapkgRulesAssemblies: assemblies,
        });
      compile();

      const run = (integrations: IntegrationInput['integrations']) =>
        reconcileIntegration({
          workspaceRoot: root,
          workspaceKind: 'project',
          directPlugins: [],
          integrations,
          complete: true,
        });
      const integrations = ['alpha', 'beta'].map((owner) => {
        const edit: SourceEdit = {
          select: 'all',
          constructorBody: `var localSetting = "${owner}";\n_ = localSetting;`,
        };
        if (owner === 'alpha') {
          edit.includes = 'using UapkgFlag = System.Boolean;';
          edit.classBody = 'private const UapkgFlag UapkgQualification = true;';
        }
        return { owner, definition: { setupModules: [edit], setupTargets: [edit] } };
      });
      expect(run(integrations).changedFiles.sort()).toEqual(
        [...originals.keys(), 'uapkg.integration-ownership.json'].sort(),
      );
      for (const file of originals.keys()) {
        const edited = readFileSync(path.join(root, file), 'utf8');
        expect(edited.match(/var localSetting = /g), file).toHaveLength(2);
        expect(edited, file).toContain('private const UapkgFlag UapkgQualification = true;');
      }
      compile();
      expect(run(integrations).changedFiles).toEqual([]);
      run([]);
      for (const [file, before] of originals) {
        expect(readFileSync(path.join(root, file)).equals(before), file).toBe(true);
      }
      process.stdout.write(
        `Compiled and round-tripped ${counts.Templates} template and ${counts.Samples} sample rules.\n`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  240_000,
);
