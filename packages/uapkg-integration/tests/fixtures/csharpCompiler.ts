import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

// The compiler is an independent oracle for the integration tests. The editor itself needs no SDK.
const sdk = spawnSync('dotnet', ['--version'], { encoding: 'utf8' });
const major = Number.parseInt(sdk.stdout?.trim() ?? '', 10);
export const hasCSharpCompiler = sdk.status === 0 && major >= 8;

export function dotnet(root: string, args: string[], additionalEnv: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync('dotnet', args, {
    cwd: root,
    env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', ...additionalEnv },
    encoding: 'utf8',
    timeout: 90_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error([result.stdout, result.stderr].join('\n'));
  return result.stdout;
}

export function writeProject(root: string, items: string, outputType = 'Library'): void {
  writeFileSync(
    path.join(root, 'NuGet.Config'),
    '<configuration><packageSources><clear/></packageSources></configuration>',
  );
  writeFileSync(
    path.join(root, 'Qualification.csproj'),
    `<Project Sdk="Microsoft.NET.Sdk">
    <PropertyGroup>
      <TargetFramework>net${major}.0</TargetFramework>
      <OutputType>${outputType}</OutputType>
      <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    </PropertyGroup>
    <ItemGroup>
      <Compile Include="Source/**/*.cs" />
      ${items}
    </ItemGroup>
  </Project>`,
  );
}
