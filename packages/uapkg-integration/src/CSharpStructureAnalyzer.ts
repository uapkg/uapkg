import path from 'node:path';
import type { Node } from 'web-tree-sitter';
import type {
  CSharpActivity,
  CSharpDeclaration,
  CSharpDocument,
  CSharpFileKind,
  ParsedConstructor,
  ParsedCSharpFile,
} from '#integration/CSharpStructures.ts';
import { CSharpBranches } from '#integration/CSharpBranches.ts';
import { CSharpUsings, hasModifier, isTopLevelType, spelling } from '#integration/CSharpUsings.ts';
import { PrettyParseError } from '#integration/PrettyParseError.ts';
import { withCSharpTree } from '#integration/csharpTree.ts';

type AcceptsBase = (declaration: CSharpDeclaration) => boolean;
type ArgumentType = 'ReadOnlyTargetRules' | 'TargetInfo';
type AcceptsParameter = (declaration: CSharpDeclaration, typeName: string, expected: ArgumentType) => boolean;

interface Constructor {
  activity: CSharpActivity;
  parameter: string;
  block: ParsedConstructor | null;
}
interface Analysis extends CSharpDocument {
  classes: CSharpDeclaration[];
  comments: CSharpDocument['comments'];
  error: number | undefined;
  includes: number | null;
  constructors: Map<CSharpDeclaration, Constructor[]>;
}

function memberContainer(node: Node): number | null {
  let parent = node.parent;
  while (parent?.type.startsWith('preproc_')) parent = parent.parent;
  if (parent?.type === 'compilation_unit') return null;
  if (parent?.type === 'declaration_list' || parent?.type === 'block') return parent.firstChild?.startIndex ?? -1;
  return -1;
}

function comments(root: Node, branches: CSharpBranches) {
  return root
    .descendantsOfType('comment')
    .filter((node) => node.text.startsWith('//'))
    .map((node) => ({
      start: node.startIndex,
      end: node.endIndex,
      activity: branches.at(node.startIndex),
      containerStart: memberContainer(node),
    }));
}

function constructors(body: Node, declaration: CSharpDeclaration, branches: CSharpBranches): Constructor[] {
  const result: Constructor[] = [];
  for (const node of body.descendantsOfType('constructor_declaration')) {
    if (
      memberContainer(node) !== declaration.classOpenBraceIndex ||
      !hasModifier(node, 'public') ||
      hasModifier(node, 'static')
    )
      continue;
    if (spelling(node.childForFieldName('name')) !== declaration.name) continue;
    const list = node.childForFieldName('parameters');
    const parameters = list?.namedChildren.filter((child) => child.type !== 'comment') ?? [];
    if (parameters.length !== 1 || parameters[0]!.type !== 'parameter') continue;
    const parameter = parameters[0]!;
    if (parameter.namedChildren.some((child) => child.type === 'modifier')) continue;
    const block = node.childForFieldName('body');
    result.push({
      activity: branches.at(node.startIndex),
      parameter: spelling(parameter.childForFieldName('type')),
      block:
        block?.type === 'block' && block.firstChild?.type === '{' && block.lastChild?.type === '}'
          ? {
              signatureIndex: node.startIndex,
              bodyOpenBraceIndex: block.firstChild.startIndex,
              bodyCloseBraceIndex: block.lastChild.startIndex,
            }
          : null,
    });
  }
  return result;
}

function analysis(source: string): Analysis {
  return withCSharpTree(source, (original) => {
    const branches = new CSharpBranches(source, original);
    const read = (root: Node): Analysis => {
      const usings = new CSharpUsings(root, branches);
      const globals = usings.globals();
      const result: Analysis = {
        classes: [],
        constructors: new Map(),
        valid: branches.balanced && !root.hasError,
        error: root.hasError ? (root.descendantsOfType('ERROR')[0]?.startIndex ?? 0) : undefined,
        globalImports: globals.imports,
        globalAliases: globals.aliases,
        conditionalGlobalAliases: globals.conditionalAliases,
        conditionalGlobalImports: globals.conditionalImports,
        directives: usings.directives,
        comments: comments(root, branches),
        includes: usings.includesBoundary(source),
      };
      if (source !== branches.source) {
        result.comments = [
          ...result.comments,
          ...comments(original, branches).filter((item) => item.activity === 'inactive'),
        ].sort((a, b) => a.start - b.start);
      }
      for (const node of root.descendantsOfType('class_declaration')) {
        const state = branches.at(node.startIndex);
        const body = node.childForFieldName('body');
        const open = body?.firstChild;
        const close = body?.lastChild;
        if (state === 'inactive' || !isTopLevelType(node) || !body || open?.type !== '{' || close?.type !== '}')
          continue;
        const name = spelling(node.childForFieldName('name'));
        const scope = usings.inScope(node);
        const firstBase = node.namedChildren
          .find((child) => child.type === 'base_list')
          ?.namedChildren.find((child) => child.type !== 'comment');
        const declaration: CSharpDeclaration = {
          name,
          className: name,
          namespace: scope.namespace,
          aliases: scope.aliases,
          imports: scope.imports,
          conditionalAliases: scope.conditionalAliases,
          conditionalImports: scope.conditionalImports,
          activity: scope.uncertainNamespace ? 'conditional' : state,
          partial: hasModifier(node, 'partial'),
          baseType: firstBase ? spelling(firstBase) : null,
          classKeywordIndex: node.children.find((child) => child.type === 'class')!.startIndex,
          classOpenBraceIndex: open.startIndex,
          classCloseBraceIndex: close.startIndex,
        };
        result.classes.push(declaration);
        result.constructors.set(declaration, constructors(body, declaration, branches));
      }
      return result;
    };
    return source === branches.source ? read(original) : withCSharpTree(branches.source, read);
  });
}

function matchesUnreal(declaration: CSharpDeclaration, name: string | null, expected: string): boolean {
  if (!name) return false;
  const first = name.split(/\.|::/)[0]!;
  if (declaration.conditionalAliases.has(first)) return false;
  const alias = declaration.aliases.get(first);
  const normalized = (alias ? alias + name.slice(first.length).replace(/^::/, '.') : name).replace(/^global::/, '');
  return normalized === expected || normalized === 'UnrealBuildTool.' + expected;
}

export class CSharpStructureAnalyzer {
  private last?: { file: string; source: string; document: Analysis };

  private document(file: string, source: string) {
    if (this.last?.file === file && this.last.source === source) return this.last.document;
    const document = analysis(source);
    this.last = { file, source, document };
    return document;
  }

  inspect(file: string, source: string): CSharpDocument {
    return this.document(file, source);
  }

  parseModule(file: string, source: string, base?: AcceptsBase, parameter?: AcceptsParameter): ParsedCSharpFile {
    return this.parse('module', file, source, base, parameter);
  }

  parseTarget(file: string, source: string, base?: AcceptsBase, parameter?: AcceptsParameter): ParsedCSharpFile {
    return this.parse('target', file, source, base, parameter);
  }

  private parse(
    kind: CSharpFileKind,
    file: string,
    source: string,
    acceptsBase?: AcceptsBase,
    acceptsParameter: AcceptsParameter = matchesUnreal,
  ): ParsedCSharpFile {
    const doc = this.document(file, source);
    if (!doc.valid)
      throw new PrettyParseError(
        file,
        'Unable to parse C# rules or balance its conditional directives',
        source,
        doc.error ?? 0,
      );
    const suffix = kind === 'module' ? '.Build.cs' : '.Target.cs';
    const name = path.basename(file, suffix) + (kind === 'target' ? 'Target' : '');
    const expectedBase = kind === 'module' ? 'ModuleRules' : 'TargetRules';
    const parameter = kind === 'module' ? 'ReadOnlyTargetRules' : 'TargetInfo';
    const candidates = doc.classes.filter((item) => item.name === name);
    const [decl] = candidates;
    if (!decl || candidates.length !== 1 || decl.activity !== 'active') {
      throw new PrettyParseError(
        file,
        'Expected one unconditional rules class named ' + name + '; found ' + candidates.length,
        source,
        decl?.classKeywordIndex ?? 0,
      );
    }
    if (!(acceptsBase ? acceptsBase(decl) : matchesUnreal(decl, decl.baseType, expectedBase))) {
      throw new PrettyParseError(
        file,
        'Could not resolve ' + name + ' as a subclass of ' + expectedBase,
        source,
        decl.classKeywordIndex,
      );
    }
    return {
      kind,
      source,
      classInfo: decl,
      get constructorInfo() {
        const matching = doc.constructors
          .get(decl)!
          .filter((item) => item.activity !== 'inactive' && acceptsParameter(decl, item.parameter, parameter));
        const [ctor] = matching;
        if (matching.length !== 1 || ctor?.activity !== 'active' || !ctor.block) {
          throw new PrettyParseError(
            file,
            'Expected one unconditional public block-bodied ' +
              name +
              '(' +
              parameter +
              ') constructor; found ' +
              matching.length,
            source,
            decl.classKeywordIndex,
          );
        }
        return ctor.block;
      },
      get includesOffset() {
        if (doc.includes === null)
          throw new PrettyParseError(
            file,
            'No unconditional position for generated using directives between extern/global and ordinary imports',
            source,
            0,
          );
        return doc.includes;
      },
    };
  }
}
