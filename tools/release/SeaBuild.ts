import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runChecked, writeJson } from '../../packages/uapkg/build/EnginePackage.ts';
import { renderRuntimeSmoke } from './Smoke.ts';

/** Build the same frozen runtime in SEA and in a separate qualification executable. */
export function buildSea(packageRoot: string, engineRoot: string, probeRoot: string, buildRoot: string): void {
  for (const root of [engineRoot, probeRoot, buildRoot]) mkdirSync(root, { recursive: true });
  const esbuildName = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
  const esbuildRelative = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
  for (const root of [engineRoot, probeRoot]) {
    const helpers = path.join(root, 'helpers');
    mkdirSync(helpers, { recursive: true });
    cpSync(
      path.join(packageRoot, 'node_modules/@esbuild', `${process.platform}-${process.arch}`, esbuildRelative),
      path.join(helpers, esbuildName),
    );
    chmodSync(path.join(helpers, esbuildName), 0o755);
    cpSync(path.join(packageRoot, 'node_modules/open/xdg-open'), path.join(helpers, 'xdg-open'));
    chmodSync(path.join(helpers, 'xdg-open'), 0o755);
  }
  const assets: Record<string, string> = {};
  for (const entry of readdirSync(packageRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    assets[path.relative(packageRoot, file).replaceAll('\\', '/')] = file;
  }
  const openSource = readFileSync(path.join(packageRoot, 'node_modules/open/index.js'), 'utf8');
  const originalHelper = "const localXdgOpenPath = path.join(__dirname, 'xdg-open');";
  if (!openSource.includes(originalHelper)) throw new Error('The pinned open dependency changed its helper selection.');
  const openPatched = path.join(buildRoot, 'open-index.js');
  writeFileSync(
    openPatched,
    openSource.replace(
      originalHelper,
      "const localXdgOpenPath = process.env.UAPKG_SEA_OPEN_HELPER || path.join(__dirname, 'xdg-open');",
    ),
  );
  assets['node_modules/open/index.js'] = openPatched;

  const prefix = `import fs from 'node:fs';
import path from 'node:path';
const helpers=path.join(path.dirname(process.execPath),'helpers');
process.env.ESBUILD_BINARY_PATH=path.join(helpers,${JSON.stringify(esbuildName)});
if(process.platform==='linux') process.env.UAPKG_SEA_OPEN_HELPER=path.join(helpers,'xdg-open');
if(!fs.existsSync(process.env.ESBUILD_BINARY_PATH)) throw new Error('The UAPKG runtime helper is missing. Reinstall this CLI version.');
`;
  const probe = path.join(buildRoot, 'runtime-probe.mjs');
  writeFileSync(
    probe,
    renderRuntimeSmoke(packageRoot, true, true).replace(
      'if (true) await new api.CredentialStore',
      "if (process.env.UAPKG_RELEASE_SMOKE_KEYRING === '1') await new api.CredentialStore",
    ),
  );
  const extension = process.platform === 'win32' ? '.exe' : '';
  for (const [name, root, entry, extra] of [
    ['engine', engineRoot, './dist/cli.js', {}],
    ['probe', probeRoot, './runtime-probe.mjs', { 'runtime-probe.mjs': probe }],
  ] as const) {
    const main = path.join(buildRoot, `${name}.mjs`);
    writeFileSync(main, `${prefix}await import(${JSON.stringify(entry)});\n`);
    const output = path.join(root, `${name}${extension}`);
    const config = path.join(buildRoot, `${name}.json`);
    writeJson(config, {
      main,
      mainFormat: 'module',
      output,
      useVfs: true,
      useSnapshot: false,
      useCodeCache: false,
      disableExperimentalSEAWarning: true,
      execArgvExtension: 'none',
      assets: { ...assets, ...extra },
    });
    runChecked(process.execPath, ['--build-sea', config], buildRoot);
    chmodSync(output, 0o755);
    if (process.platform === 'darwin') runChecked('codesign', ['--force', '--sign', '-', output], buildRoot);
  }
}
