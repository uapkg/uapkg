import fs from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { integrationAuthorModule } from '@uapkg/integration/runtime';
import { build, transform, type Loader } from 'esbuild';
import { checkedEntry, within } from '#lifecycle/entries.ts';

/** Resolve only the package's own runtime files, Node builtins, and the authoring helper. */
export async function prepareLifecycleEntry(packageRoot: string, entry: string) {
  // Use native physical paths on both sides of the check, including Windows 8.3 aliases.
  const root = await fs.promises.realpath(packageRoot);
  const source = checkedEntry(root, entry);
  const result = await build({
    entryPoints: [source],
    absWorkingDir: root,
    write: false,
    bundle: true,
    metafile: true,
    preserveSymlinks: true,
    format: 'esm',
    platform: 'node',
    target: 'esnext',
    tsconfigRaw: {},
    logLevel: 'silent',
    banner: {
      js: "import {createRequire as __uapkgCreateRequire} from 'node:module'; const require = __uapkgCreateRequire(import.meta.url);",
    },
    plugins: [
      {
        name: 'uapkg-lifecycle-inputs',
        setup(builder) {
          builder.onLoad({ filter: /.*/, namespace: 'file' }, async (args) => {
            const physical = await fs.promises.realpath(args.path);
            if (!within(root, physical))
              return { errors: [{ text: 'Lifecycle import is outside the package: ' + args.path }] };
            if (!/\.(?:[cm]?[tj]s|[tj]sx)$/i.test(args.path)) return;
            const contents = await fs.promises.readFile(physical, 'utf8');
            if (!/import\.meta|\b__(?:dirname|filename)\b/.test(contents)) return;
            // Bundling moves source modules into an isolated temporary file. Preserve the
            // source URL per module so a bundled helper can open a sibling asset.
            const suffix = path.extname(args.path).slice(1).replace(/^[cm]/, '') as Loader;
            const result = await transform(contents, {
              loader: suffix,
              target: 'esnext',
              sourcefile: args.path,
              tsconfigRaw: {},
              define: {
                __filename: JSON.stringify(args.path),
                __dirname: JSON.stringify(path.dirname(args.path)),
                'import.meta.url': JSON.stringify(pathToFileURL(args.path).href),
                'import.meta.filename': JSON.stringify(args.path),
                'import.meta.dirname': JSON.stringify(path.dirname(args.path)),
              },
            });
            return { contents: result.code, loader: 'js', resolveDir: path.dirname(args.path) };
          });
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === 'entry-point') return;
            if (args.path === '@uapkg/integration') return { path: 'author-helper', namespace: 'uapkg' };
            if (isBuiltin(args.path)) return { path: args.path, external: true };
            if (args.path.startsWith('./') || args.path.startsWith('../')) return;
            return {
              errors: [
                { text: 'Bundle third-party dependencies into your lifecycle entry. Unsupported import: ' + args.path },
              ],
            };
          });
          builder.onLoad({ filter: /.*/, namespace: 'uapkg' }, () => ({
            contents: integrationAuthorModule,
            loader: 'js',
          }));
        },
      },
    ],
  });
  const files = Object.keys(result.metafile.inputs).filter((file) => !file.startsWith('uapkg:'));
  return { code: result.outputFiles[0].text, files };
}
