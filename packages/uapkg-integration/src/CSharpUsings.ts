import type { Node } from 'web-tree-sitter';
import type { CSharpDirective } from '#integration/CSharpStructures.ts';
import type { CSharpBranches } from '#integration/CSharpBranches.ts';

export function spelling(node: Node | null | undefined): string {
  if (!node) return '';
  if (node.type === 'comment') return '';
  if (!node.childCount) return node.text.replace(/^@/, '');
  return node.children.map(spelling).join('');
}

export function hasModifier(node: Node, modifier: string): boolean {
  return node.namedChildren.some((child) => child.type === 'modifier' && child.text === modifier);
}

function namespaces(node: Node): Node[] {
  const names: Node[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'namespace_declaration') names.unshift(parent);
  }
  return names;
}

export function isTopLevelType(node: Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type.endsWith('_declaration') && parent.type !== 'namespace_declaration') return false;
    if (parent.type === 'block') return false;
  }
  return true;
}

interface Using {
  kind: CSharpDirective['kind'];
  name: string;
  alias: string | undefined;
  conditional: boolean;
  scope: number;
}

/** Imports are scoped to a compilation unit or namespace body, including file-scoped namespaces. */
export class CSharpUsings {
  private readonly usings: Using[] = [];
  private readonly fileScope: Node | undefined;
  private readonly uncertainFileNamespace: boolean;
  readonly directives: CSharpDirective[] = [];
  private readonly requiredEnds: number[] = [];
  private readonly ordinaryStarts: number[] = [];

  private readonly root: Node;
  constructor(root: Node, branches: CSharpBranches) {
    this.root = root;
    const fileScopes = root
      .descendantsOfType('file_scoped_namespace_declaration')
      .filter((node) => branches.at(node.startIndex) !== 'inactive');
    this.fileScope = fileScopes[0];
    this.uncertainFileNamespace =
      fileScopes.length > 1 || (!!this.fileScope && branches.at(this.fileScope.startIndex) === 'conditional');
    for (const node of root.descendantsOfType([
      'extern_alias_directive',
      'using_directive',
      'preproc_define',
      'preproc_undef',
    ])) {
      const activity = branches.at(node.startIndex);
      if (activity === 'inactive') continue;
      const ns = namespaces(node).at(-1);
      const scope =
        ns?.id ?? (this.fileScope && this.fileScope.endIndex <= node.startIndex ? this.fileScope.id : root.id);
      let branch = node;
      while (branch.parent?.type.startsWith('preproc_')) branch = branch.parent;
      if (node.type.startsWith('preproc_')) {
        if (scope === root.id) this.requiredEnds.push(branch.endIndex);
        continue;
      }
      const kind =
        node.type === 'extern_alias_directive'
          ? 'extern'
          : node.children.some((child) => child.type === 'global')
            ? 'global'
            : 'ordinary';
      if (scope === root.id) {
        this.directives.push({ start: node.startIndex, end: node.endIndex, kind });
        if (kind === 'ordinary') this.ordinaryStarts.push(branch.startIndex);
        else this.requiredEnds.push(branch.endIndex);
      }
      if (kind === 'extern' || node.children.some((child) => child.type === 'static')) continue;
      const alias = node.childForFieldName('name');
      const target = node.namedChildren.filter((child) => child.type !== 'comment').at(-1);
      this.usings.push({
        name: spelling(target),
        alias: alias ? spelling(alias) : undefined,
        kind,
        scope,
        conditional: activity === 'conditional',
      });
    }
  }

  inScope(node: Node) {
    const groups = namespaces(node);
    if (this.fileScope && this.fileScope.endIndex <= node.startIndex) groups.unshift(this.fileScope);
    const scopes = [this.root.id, ...groups.map((group) => group.id)];
    const visible = scopes.flatMap((scope) => this.usings.filter((item) => item.scope === scope));
    return {
      namespace: groups.map((group) => spelling(group.childForFieldName('name'))).join('.'),
      uncertainNamespace: !!this.fileScope && groups.includes(this.fileScope) && this.uncertainFileNamespace,
      ...this.collect(visible),
    };
  }

  globals() {
    return this.collect(this.usings.filter((item) => item.scope === this.root.id && item.kind === 'global'));
  }

  private collect(items: Using[]) {
    const aliases = new Map<string, string>();
    const imports: string[] = [];
    const conditionalAliases = new Set<string>();
    const conditionalImports: string[] = [];
    for (const item of items) {
      if (item.conditional && item.alias) conditionalAliases.add(item.alias);
      else if (item.conditional) conditionalImports.push(item.name);
      else if (item.alias) aliases.set(item.alias, item.name);
      else imports.push(item.name);
    }
    return { aliases, imports, conditionalAliases, conditionalImports };
  }

  includesBoundary(source: string): number | null {
    const requiredEnd = Math.max(0, ...this.requiredEnds);
    if (this.ordinaryStarts.some((start) => start < requiredEnd)) return null;
    let end = requiredEnd;
    // Keep an initial license, BOM, and header directives, while leaving doc comments attached to their declaration.
    if (!end) {
      end = source.startsWith('\uFEFF') ? 1 : 0;
      for (const child of this.root.namedChildren) {
        const headerComment =
          child.type === 'comment' && !child.text.startsWith('///') && !child.text.startsWith('/**');
        if (!headerComment && !['preproc_nullable', 'preproc_pragma', 'shebang_directive'].includes(child.type)) break;
        end = child.endIndex;
      }
    }
    if (!end || (end === 1 && source.startsWith('\uFEFF')) || source[end - 1] === '\n') return end;
    // Preserve a trailing inline comment on the original directive. At EOF or before a
    // second declaration on the same line the caller supplies a separating newline.
    let cursor = end;
    for (const comment of this.root.descendantsOfType('comment')) {
      if (comment.startIndex < cursor) continue;
      if (!/^[\t ]*$/.test(source.slice(cursor, comment.startIndex))) break;
      cursor = comment.endIndex;
    }
    return cursor + (/^[\t ]*(?:\r\n|\r|\n)/.exec(source.slice(cursor))?.[0].length ?? 0);
  }
}
