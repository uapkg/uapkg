import type { Node } from 'web-tree-sitter';
import type { CSharpActivity } from '#integration/CSharpStructures.ts';
import { withCSharpTree } from '#integration/csharpTree.ts';

type Truth = boolean | undefined;

function and(left: Truth, right: Truth): Truth {
  return left === false || right === false ? false : left === true && right === true ? true : undefined;
}
function not(value: Truth): Truth {
  return value === undefined ? undefined : !value;
}

/** Symbols supplied by the build can vary between configurations. Only file-local definitions are certain. */
function condition(node: Node | null | undefined, symbols: Map<string, Truth>): Truth {
  if (!node) return undefined;
  switch (node.type) {
    case 'boolean_literal':
      return node.text === 'true';
    case 'identifier':
      return symbols.get(node.text);
    case 'parenthesized_expression':
      return condition(
        node.namedChildren.find((child) => child.type !== 'comment'),
        symbols,
      );
    case 'unary_expression':
      return not(condition(node.childForFieldName('argument'), symbols));
    case 'binary_expression': {
      const left = condition(node.childForFieldName('left'), symbols);
      const right = condition(node.childForFieldName('right'), symbols);
      switch (node.childForFieldName('operator')?.type) {
        case '&&':
          return and(left, right);
        case '||':
          return not(and(not(left), not(right)));
        case '==':
          return left === undefined || right === undefined ? undefined : left === right;
        case '!=':
          return left === undefined || right === undefined ? undefined : left !== right;
      }
    }
  }
  return undefined;
}

export class CSharpBranches {
  readonly source: string;
  readonly balanced: boolean;
  private readonly spans: { end: number; state: CSharpActivity }[] = [];

  constructor(source: string, root: Node, parsedSource = source) {
    const tokens = new Map(
      root
        .descendantsOfType(['#if', '#elif', '#else', '#endif', '#define', '#undef'])
        .filter((token) => !token.isMissing)
        .map((token) => [token.startIndex, token]),
    );
    const symbols = new Map<string, Truth>();
    const stack: { parent: Truth; remaining: Truth }[] = [];
    const chunks: string[] = [];
    let valid = true;
    let cursor = 0;
    let state: Truth = true;
    let masked = false;
    const append = (end: number, keep: boolean) => {
      if (end === cursor) return;
      const text = source.slice(cursor, end);
      chunks.push(keep || state !== false ? text : text.replace(/[^\r\n]/g, ' '));
      this.spans.push({ end, state: state === undefined ? 'conditional' : state ? 'active' : 'inactive' });
      masked ||= state === false && !keep;
      cursor = end;
    };
    // Use the grammar's directive tokens. Inside disabled text C# recognizes nesting
    // directives even when the disabled region contains arbitrary non-C# characters.
    for (const match of source.matchAll(/^[\t \uFEFF]*#[\t ]*(if|elif|else|endif|define|undef)\b[^\r\n]*/gm)) {
      const start = match.index;
      const token = tokens.get(start + match[0].indexOf('#'));
      if (!token && state !== false) continue;
      append(start, false);
      const directive = match[1];
      append(start + match[0].length, true);
      const evaluate = () => {
        const expression = token?.parent?.childForFieldName('condition');
        if (expression) return condition(expression, symbols);
        // Disabled text need not lex as C#. It can swallow a later directive in the
        // initial syntax tree, so parse that directive's condition on its own.
        const header = match[0].replace(/^[^#]*#[\t ]*(?:if|elif)\b/, '#if');
        return withCSharpTree(header + '\n#endif', (unit) =>
          condition(unit.firstNamedChild?.childForFieldName('condition'), symbols),
        );
      };
      if (directive === 'define' || directive === 'undef') {
        const argument = token?.parent?.namedChildren.find((child) => child.type === 'preproc_arg')?.text;
        const name = argument?.split('//', 1)[0]?.trim();
        if (name && state !== false) {
          const value = directive === 'define';
          symbols.set(name, state === true || symbols.get(name) === value ? value : undefined);
        }
      } else if (directive === 'if') {
        const value = evaluate();
        stack.push({ parent: state, remaining: not(value) });
        state = and(state, value);
      } else {
        const frame = stack.at(-1);
        if (!frame) {
          valid = false;
          continue;
        }
        if (directive === 'endif') {
          state = frame.parent;
          stack.pop();
        } else {
          const value = directive === 'else' ? true : evaluate();
          state = and(frame.parent, and(frame.remaining, value));
          frame.remaining = and(frame.remaining, not(value));
        }
      }
    }
    append(source.length, false);
    this.source = masked ? chunks.join('') : source;
    this.balanced = valid && !stack.length;
    if (root.hasError && masked && this.source !== parsedSource) {
      // A malformed token in a disabled region may have hidden later directives.
      // Recover their syntax and re-evaluate the original offsets after blanking that region.
      const next = withCSharpTree(this.source, (unit) => new CSharpBranches(source, unit, this.source));
      this.spans = next.spans;
      this.source = next.source;
      this.balanced = next.balanced;
    }
  }

  at(offset: number): CSharpActivity {
    let low = 0;
    let high = this.spans.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.spans[mid]!.end <= offset) low = mid + 1;
      else high = mid;
    }
    return this.spans[low]?.state ?? 'active';
  }
}
