export type CSharpFileKind = 'module' | 'target';
export type CSharpActivity = 'active' | 'conditional' | 'inactive';

export interface CSharpDeclaration extends ParsedClass {
  readonly name: string;
  readonly namespace: string;
  readonly baseType: string | null;
  readonly imports: readonly string[];
  readonly aliases: ReadonlyMap<string, string>;
  readonly conditionalAliases: ReadonlySet<string>;
  readonly conditionalImports: readonly string[];
  readonly activity: Exclude<CSharpActivity, 'inactive'>;
  readonly partial: boolean;
}

export interface CSharpDirective {
  readonly start: number;
  readonly end: number;
  readonly kind: 'extern' | 'global' | 'ordinary';
}

export interface CSharpDocument {
  readonly valid: boolean;
  readonly classes: readonly CSharpDeclaration[];
  readonly comments: readonly { start: number; end: number; activity: CSharpActivity; containerStart: number | null }[];
  readonly directives: readonly CSharpDirective[];
  readonly globalImports: readonly string[];
  readonly globalAliases: ReadonlyMap<string, string>;
  readonly conditionalGlobalAliases: ReadonlySet<string>;
  readonly conditionalGlobalImports: readonly string[];
}

export interface ParsedClass {
  readonly className: string;
  readonly classKeywordIndex: number;
  readonly classOpenBraceIndex: number;
  readonly classCloseBraceIndex: number;
}

export interface ParsedConstructor {
  readonly signatureIndex: number;
  readonly bodyOpenBraceIndex: number;
  readonly bodyCloseBraceIndex: number;
}

export interface ParsedCSharpFile {
  readonly kind: CSharpFileKind;
  readonly classInfo: ParsedClass;
  readonly constructorInfo: ParsedConstructor;
  readonly source: string;
  readonly includesOffset: number;
}
