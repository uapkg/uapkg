import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Language, Parser, type Node } from 'web-tree-sitter';

// Reading package assets explicitly also works in Node's single-executable virtual filesystem.
const resolveAsset = createRequire(import.meta.url).resolve;
await Parser.init({ wasmBinary: readFileSync(resolveAsset('web-tree-sitter/web-tree-sitter.wasm')) });
const grammar = await Language.load(readFileSync(resolveAsset('@lumis-sh/wasm-csharp/tree-sitter-csharp.wasm')));
const parser = new Parser().setLanguage(grammar);

/** Web Tree-sitter exposes UTF-16 offsets for JS strings. Do not retain nodes after this callback. */
export function withCSharpTree<T>(source: string, use: (root: Node) => T): T {
  const tree = parser.parse(source);
  if (!tree) throw new Error('The C# parser could not read the source.');
  try {
    return use(tree.rootNode);
  } finally {
    tree.delete();
  }
}
