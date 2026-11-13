import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, runChecked } from '../../packages/uapkg/build/EnginePackage.ts';
import { smokePackagedTerminal } from './PackagedTerminalSmoke.ts';
import { safeEngineCommand, type EngineDescriptor } from './ReleaseArtifacts.ts';

/** Capture each frame even in CI, and wait for observable rendering/input readiness. */
export function renderInkSmoke(): string {
  return `const {PassThrough} = await import('node:stream');
const React = (await import(pathToFileURL(require.resolve('react')).href)).default;
const {render, Text, useInput} = await import(pathToFileURL(require.resolve('ink')).href);
const input = new PassThrough();
const output = new PassThrough();
const errors = new PassThrough();
const rawModes = [];
const initialFrame = Promise.withResolvers();
const updatedFrame = Promise.withResolvers();
const inputReady = Promise.withResolvers();
input.isTTY = true; input.setRawMode = value => {rawModes.push(value); return input;};
input.ref = () => input; input.unref = () => input;
output.isTTY = true; output.columns = 80; output.rows = 24;
let rendered = '';
output.on('data', data => {
  rendered += data.toString();
  if (rendered.includes('release-render-ready')) initialFrame.resolve();
  if (rendered.includes('release-input-ok')) updatedFrame.resolve();
});
function Probe() {
  const [text, setText] = React.useState('release-render-ready');
  useInput(value => {if (value === 'x') setText('release-input-ok');});
  React.useEffect(() => {inputReady.resolve();}, []);
  return React.createElement(Text, null, text);
}
async function waitForProbe(promise, phase) {
  let timer;
  try {
    await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for Ink ' + phase)), 5000);
    })]);
  } finally {clearTimeout(timer);}
}
// Ink normally suppresses intermediate frames in CI. Its supported debug mode
// records every frame so both the first render and input-driven update are tested.
const screen = render(React.createElement(Probe), {stdin:input,stdout:output,stderr:errors,debug:true,exitOnCtrlC:false,patchConsole:false});
try {
  await waitForProbe(Promise.all([initialFrame.promise, inputReady.promise]), 'initial render and input setup');
  input.write('x');
  await waitForProbe(updatedFrame.promise, 'input-driven render');
} finally {
  screen.unmount();
  await screen.waitUntilExit();
}
assert.match(rendered, /release-render-ready/); assert.match(rendered, /release-input-ok/);
assert.equal(rawModes.includes(true), true); assert.equal(rawModes.at(-1), false);
`;
}

export function renderRuntimeSmoke(engineRoot: string, keyring: boolean, virtual = false): string {
  return `import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const engineRoot = ${virtual ? 'import.meta.dirname' : JSON.stringify(engineRoot)};
const require = createRequire(path.join(engineRoot, 'package.json'));
const api = await import(${virtual ? "new URL('./dist/index.js', import.meta.url)" : JSON.stringify(pathToFileURL(path.join(engineRoot, 'dist/index.js')).href)});
assert.equal(typeof api.runUAPKGCLI, 'function');
assert.equal(typeof api.CredentialStore, 'function');
const fixture = path.join(process.cwd(), 'postinstall.mjs');
const sibling = path.join(process.cwd(), 'sibling.mjs');
fs.writeFileSync(sibling, 'export const value = 42;');
fs.writeFileSync(fixture, 'import {value} from "./sibling.mjs"; export default {value};');
const imported = await new api.ModuleImporter().import('release-fixture', {kind:'file', path:fixture});
assert.equal(imported.ok, true, JSON.stringify(imported));
assert.equal(imported.value.default.value, 42);
const tsFixture = path.join(process.cwd(), 'postinstall.ts');
fs.writeFileSync(tsFixture, 'const value: number = 42; export default { value };');
const transpiled = await new api.EsbuildTranspiler().transpile('release-fixture', tsFixture);
assert.equal(transpiled.ok, true, JSON.stringify(transpiled));
const loaded = await new api.ModuleImporter().import('release-fixture', {kind:'transpiled', code:transpiled.value, originalPath:tsFixture});
assert.equal(loaded.ok, true, JSON.stringify(loaded));
assert.equal(loaded.value.default.value, 42);
const browser = await import(pathToFileURL(require.resolve('open')).href);
assert.equal(typeof browser.default, 'function');
if (process.platform === 'linux') assert.equal(fs.existsSync(path.join(path.dirname(require.resolve('open')), 'xdg-open')), true);
if (process.env.UAPKG_SEA_OPEN_HELPER) assert.match(execFileSync(process.env.UAPKG_SEA_OPEN_HELPER, ['--version'], {encoding:'utf8'}), /xdg-open/);
${renderInkSmoke()}
execFileSync('git', ['init', '--quiet'], {cwd:process.cwd(), stdio:'pipe'});
assert.equal(execFileSync('git',['rev-parse','--is-inside-work-tree'],{cwd:process.cwd(),encoding:'utf8'}).trim(),'true');
if (${JSON.stringify(keyring)}) await new api.CredentialStore(undefined, 'uapkg.cli.release-smoke').assertAvailable();
console.log('Engine smoke passed: public exports, dynamic imports, TypeScript/esbuild, browser assets, Ink input/render, Git/filesystem${keyring ? ', secure keyring' : ''}.');
`;
}

export function smokeEngine(root: string, options: { keyring?: boolean; native?: boolean } = {}): void {
  const engineRoot = path.resolve(root);
  const descriptor = options.native ? readJson<EngineDescriptor>(path.join(engineRoot, 'engine.json')) : undefined;
  const version = descriptor?.version ?? readJson<{ version: string }>(path.join(engineRoot, 'package.json')).version;
  const command = descriptor
    ? safeEngineCommand(engineRoot, descriptor)
    : { executable: process.execPath, args: [path.join(engineRoot, 'dist/cli.js')] };
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'uapkg-release-smoke-'));
  const cwd = path.join(scratch, 'project with spaces ü');
  mkdirSync(cwd);
  const emptyPath = path.join(scratch, 'no system binaries');
  mkdirSync(emptyPath);
  const env = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', NO_COLOR: '1', FORCE_COLOR: '0' };
  try {
    const output = runChecked(command.executable, [...command.args, '--version'], cwd, env);
    if (output.trim() !== version) throw new Error(`Unexpected engine version: ${output.trim()}`);
    runChecked(command.executable, [...command.args, '--help'], cwd, env);
    // The collector must work inside both bundled runtimes, including when no
    // user Node/npm is on PATH. envinfo debug logging must never leak the env.
    const diagnosticSentinel = 'uapkg-release-smoke-private-environment-value';
    for (const diagnosticEnv of [env, { ...env, PATH: emptyPath }]) {
      const diagnostic = spawnSync(command.executable, [...command.args, '--debug-info'], {
        cwd,
        env: {
          ...diagnosticEnv,
          ENVINFO_DEBUG: 'trace',
          UAPKG_RELEASE_SMOKE_SECRET: diagnosticSentinel,
        },
        encoding: 'utf8',
        timeout: 25_000,
        windowsHide: true,
      });
      if (diagnostic.error || diagnostic.status !== 0)
        throw new Error(`Packaged diagnostics failed: ${diagnostic.error?.message ?? diagnostic.stderr}`);
      if (
        !diagnostic.stdout.includes('UAPKG debug information') ||
        !diagnostic.stdout.includes('System:') ||
        !diagnostic.stdout.includes('Environment collection: available')
      )
        throw new Error('Packaged diagnostics did not collect environment information successfully.');
      const cliPath = descriptor?.kind === 'sea' ? command.executable : command.args[0];
      if (!diagnostic.stdout.includes(`CLI path: ${cliPath}\n`))
        throw new Error('Packaged diagnostics did not report the executing CLI location.');
      if (`${diagnostic.stdout}${diagnostic.stderr}`.includes(diagnosticSentinel))
        throw new Error('Packaged diagnostics exposed a private environment value.');
    }
    const invalid = spawnSync(command.executable, [...command.args, 'release-smoke-unknown-command'], {
      cwd,
      env,
      encoding: 'utf8',
    });
    if (invalid.status === 0) throw new Error('Unknown command should preserve a nonzero exit status.');
    if (descriptor?.kind === 'sea') {
      const probe = path.join(engineRoot, '../sea-smoke', `probe${process.platform === 'win32' ? '.exe' : ''}`);
      process.stdout.write(
        runChecked(probe, [], cwd, { ...env, UAPKG_RELEASE_SMOKE_KEYRING: options.keyring ? '1' : '0' }),
      );
    } else {
      const probe = path.join(scratch, 'probe.mjs');
      writeFileSync(probe, renderRuntimeSmoke(engineRoot, options.keyring ?? false));
      process.stdout.write(runChecked(command.executable, [probe], cwd, env));
    }
    if (options.native) smokePackagedTerminal(engineRoot);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
