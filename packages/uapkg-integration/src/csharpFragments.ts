import type { Node } from 'web-tree-sitter';
import { CSharpBranches } from '#integration/CSharpBranches.ts';
import { withCSharpTree } from '#integration/csharpTree.ts';
import type { BlockOwner } from '#integration/ownership.ts';

type Contributions = BlockOwner['contributions'];
type ImportKind = 'global' | 'ordinary';

function withFragment<T>(source: string, description: string, read: (node: Node) => T): T {
  return withCSharpTree(source, (original) => {
    const conditions = new CSharpBranches(source, original);
    if (!conditions.balanced) throw new Error(`Unbalanced conditional directives in ${description}.`);
    const check = (root: Node) => {
      if (root.hasError) throw new Error(`Invalid C# syntax in ${description}.`);
      return read(root);
    };
    return conditions.source === source ? check(original) : withCSharpTree(conditions.source, check);
  });
}

/** Keep a conditional and its branches together when ordering generated imports. */
function importKinds(node: Node, kinds: Set<ImportKind>, file: string): void {
  if (node.type === 'comment') return;
  if (node.type === 'using_directive') {
    kinds.add(node.firstChild?.type === 'global' ? 'global' : 'ordinary');
    return;
  }
  if (node.type === 'preproc_if' || node.type === 'preproc_elif' || node.type === 'preproc_else') {
    const condition = node.childForFieldName('condition');
    for (const child of node.namedChildren) {
      if (child.id !== condition?.id) importKinds(child, kinds, file);
    }
    return;
  }
  throw new Error(`Expected C# using directives in includes for ${file}; found ${node.type}.`);
}

function orderedIncludes(contributions: Contributions, file: string): string {
  const globals = new Set<string>();
  const ordinary = new Set<string>();
  for (const { owner, snippets } of contributions) {
    const code = snippets.join('\n');
    withFragment(code, `includes from ${owner} for ${file}`, (root) => {
      const nodes = root.namedChildren;
      const finalDirective = nodes.filter((node) => node.type !== 'comment').at(-1)?.id;
      let start = 0;
      for (let i = 0; i < nodes.length; i++) {
        const directive = nodes[i];
        if (directive.type === 'comment') continue;
        const kinds = new Set<ImportKind>();
        importKinds(directive, kinds, file);
        if (kinds.size > 1) {
          throw new Error(`Separate conditional global and ordinary using directives in includes for ${file}.`);
        }
        // A comment on the directive's line follows that directive when it moves.
        // Standalone comments introduce the next directive, or trail the final one.
        let last = directive;
        while (nodes[i + 1]?.type === 'comment' && nodes[i + 1].startPosition.row === last.endPosition.row) {
          last = nodes[++i];
        }
        const group = kinds.has('global') ? globals : ordinary;
        const end = directive.id === finalDirective ? code.length : last.endIndex;
        group.add(code.slice(start, end).trim());
        start = end;
      }
      if (start === 0 && code.length) ordinary.add(code);
    });
  }
  return [...globals, ...ordinary].join('\n');
}

/** Validate the snippet inside its intended C# scope before indenting its code lines. */
function indentFragment(code: string, indent: string, constructor: boolean, context: string): string {
  const prefix = constructor ? 'class __Uapkg {\n__Uapkg() {\n' : 'class __Uapkg {\n';
  const suffix = constructor ? '\n}\n}' : '\n}';
  return withFragment(prefix + code + suffix, context, (root) => {
    const declaration = root.firstNamedChild;
    const members = declaration?.childForFieldName('body');
    const body = constructor ? members?.firstNamedChild?.childForFieldName('body') : members;
    if (root.namedChildCount !== 1 || body?.lastChild?.startIndex !== prefix.length + code.length + 1) {
      throw new Error(`C# fragment escapes its scope in ${context}.`);
    }
    const literalRows = new Set<number>();
    for (const literal of body.descendantsOfType([
      'verbatim_string_literal',
      'raw_string_literal',
      'interpolated_string_expression',
    ])) {
      // Additional leading whitespace changes verbatim literal values and can
      // invalidate the closing delimiter of a multiline raw string.
      for (let row = literal.startPosition.row + 1; row <= literal.endPosition.row; row++) literalRows.add(row);
    }
    const firstRow = constructor ? 2 : 1;
    return code
      .split('\n')
      .map((line, i) => (line && !literalRows.has(firstRow + i) ? indent + line : line))
      .join('\n');
  });
}

export function renderBlock(
  zone: BlockOwner['zone'],
  indent: string,
  eol: string,
  contributions: Contributions,
  file: string,
): string {
  let code: string;
  if (zone === 'includes') {
    code = orderedIncludes(contributions, file);
  } else if (zone === 'classBody') {
    const shared = [...new Set(contributions.flatMap((c) => c.snippets))].join('\n');
    code = indentFragment(shared, indent, false, `classBody for ${file}`);
  } else {
    const inner = indent + (indent.endsWith('\t') ? '\t' : '    ');
    code = contributions
      .map(({ owner, snippets }) =>
        [
          indent + '{',
          indentFragment(snippets.join('\n'), inner, true, `constructorBody from ${owner} for ${file}`),
          indent + '}',
        ].join('\n'),
      )
      .join('\n');
  }
  return [indent + `// UAPKG-BEGIN integration:${zone}`, code, indent + `// UAPKG-END integration:${zone}`]
    .join('\n')
    .replaceAll('\n', eol);
}
