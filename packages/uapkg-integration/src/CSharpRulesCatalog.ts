import fs from 'node:fs';
import { CSharpStructureAnalyzer } from '#integration/CSharpStructureAnalyzer.ts';
import type { CSharpDeclaration } from '#integration/CSharpStructures.ts';
import type { Workspace } from '#integration/workspace.ts';

interface CatalogEntry {
  declaration: CSharpDeclaration;
  file: string;
  valid: boolean;
}

/** Resolve Unreal rules inheritance against the consuming workspace's own C# declarations. */
export class CSharpRulesCatalog {
  readonly analyzer = new CSharpStructureAnalyzer();
  private sources?: string[];
  private declarations?: Map<string, CatalogEntry[]>;
  private readonly imports = new Set<string>();
  private readonly aliases = new Map<string, Set<string>>();
  private readonly conditionalAliases = new Set<string>();
  private readonly conditionalImports = new Set<string>();

  constructor(private readonly workspace: Workspace) {}

  sourceFiles(): readonly string[] {
    if (this.sources) return this.sources;
    const result: string[] = [];
    const visit = (directory: string): void => {
      if (this.workspace.installed(directory) || !fs.existsSync(this.workspace.path(directory))) return;
      for (const child of fs.readdirSync(this.workspace.path(directory), { withFileTypes: true })) {
        const file = directory + '/' + child.name;
        if (this.workspace.installed(file)) continue;
        if (child.isDirectory()) visit(file);
        else if (child.isFile() && child.name.endsWith('.cs')) result.push(file);
      }
    };
    visit('Source');
    this.sources = result.sort();
    return this.sources;
  }

  private index(): Map<string, CatalogEntry[]> {
    if (this.declarations) return this.declarations;
    const entries = new Map<string, CatalogEntry[]>();
    for (const file of this.sourceFiles()) {
      const document = this.analyzer.inspect(file, this.workspace.get(file)!);
      for (const declaration of document.classes) {
        const name = [declaration.namespace, declaration.name].filter(Boolean).join('.');
        const existing = entries.get(name) ?? [];
        existing.push({ declaration, file, valid: document.valid });
        entries.set(name, existing);
      }
      if (!document.valid) continue;
      for (const name of document.globalImports) this.imports.add(name.replace(/^global::/, ''));
      for (const name of document.conditionalGlobalImports) this.conditionalImports.add(name);
      for (const name of document.conditionalGlobalAliases) this.conditionalAliases.add(name);
      for (const [name, target] of document.globalAliases) {
        const values = this.aliases.get(name) ?? new Set<string>();
        values.add(target);
        this.aliases.set(name, values);
      }
    }
    this.declarations = entries;
    return entries;
  }

  private resolveType(current: CSharpDeclaration, spelling: string, unreal: string): string | undefined {
    const entries = this.index();
    const known = (name: string) => name === unreal || entries.has(name);
    let type = spelling;
    if (!type.startsWith('global::')) {
      const first = type.split(/\.|::/, 1)[0]!;
      const local = current.aliases.get(first);
      const globals = this.aliases.get(first);
      if (current.conditionalAliases.has(first) || (!local && this.conditionalAliases.has(first))) {
        throw new Error(`C# alias "${first}" depends on build symbols in ${current.name}.`);
      }
      if (!local && globals && globals.size > 1) throw new Error(`Ambiguous global C# alias "${first}".`);
      const alias = local ?? globals?.values().next().value;
      if (alias) type = alias + type.slice(first.length);
      else if (type.includes('::')) return undefined;
    }
    const absolute = type.startsWith('global::');
    type = type.replace(/^global::/, '').replaceAll('::', '.');
    if (absolute) return known(type) ? type : undefined;
    const nearest = current.namespace ? current.namespace + '.' + type : type;
    if (known(nearest)) return nearest;
    const candidates = new Set<string>();
    // Imported types and declarations in enclosing namespaces can both be visible.
    // Require an unambiguous identity before using one to authorize an edit.
    let scope = current.namespace;
    while (scope) {
      scope = scope.split('.').slice(0, -1).join('.');
      const qualified = scope ? scope + '.' + type : type;
      if (known(qualified)) {
        candidates.add(qualified);
        break;
      }
    }
    for (const ns of [...current.imports, ...this.imports]) {
      const qualified = ns.replace(/^global::/, '') + '.' + type;
      if (known(qualified)) candidates.add(qualified);
    }
    for (const ns of [...current.conditionalImports, ...this.conditionalImports]) {
      const qualified = ns.replace(/^global::/, '') + '.' + type;
      if (known(qualified) && !candidates.has(qualified)) {
        throw new Error(`C# type "${spelling}" depends on a conditional namespace import in ${current.name}.`);
      }
    }
    if (candidates.size > 1)
      throw new Error(`Ambiguous C# type "${spelling}" in ${current.name}: ${[...candidates].join(', ')}.`);
    return candidates.values().next().value;
  }

  isParameter = (
    declaration: CSharpDeclaration,
    type: string,
    expected: 'TargetInfo' | 'ReadOnlyTargetRules',
  ): boolean => {
    const unreal = 'UnrealBuildTool.' + expected;
    return this.resolveType(declaration, type, unreal) === unreal && !this.index().has(unreal);
  };

  /** A matching filename or constructor alone cannot establish a rules class's ancestry. */
  derivesFrom(declaration: CSharpDeclaration, expected: 'ModuleRules' | 'TargetRules', file: string): boolean {
    const entries = this.index();
    const unreal = 'UnrealBuildTool.' + expected;
    const seen = new Set<string>();
    let name: string | undefined = [declaration.namespace, declaration.name].filter(Boolean).join('.');
    while (name && name !== unreal) {
      if (seen.has(name)) throw new Error(`Cycle in Unreal rules inheritance at ${name}.`);
      seen.add(name);
      const candidates = entries.get(name);
      if (!candidates) return false;
      if (
        candidates.some((entry) => !entry.valid || entry.declaration.activity !== 'active') ||
        (candidates.length > 1 && !candidates.every((entry) => entry.declaration.partial))
      ) {
        throw new Error(
          `Cannot identify one active C# rules type "${name}" in ${candidates.map((entry) => entry.file).join(', ')}.`,
        );
      }
      const bases = new Set<string>();
      for (const part of candidates) {
        // The selected file may already have staged edits to its imports.
        const current =
          part.file === file &&
          part.declaration.name === declaration.name &&
          part.declaration.namespace === declaration.namespace
            ? declaration
            : part.declaration;
        if (!current.baseType) continue;
        const base = this.resolveType(current, current.baseType, unreal);
        if (!base) return false;
        bases.add(base);
      }
      if (bases.size > 1) throw new Error(`Conflicting base classes for partial C# type "${name}".`);
      name = bases.values().next().value;
    }
    return name === unreal && !entries.has(unreal);
  }
}
