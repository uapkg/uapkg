import path from 'node:path';
import type { CSharpRulesCatalog } from '#integration/CSharpRulesCatalog.ts';
import { renderBlock } from '#integration/csharpFragments.ts';
import type { SourceEdit } from '#integration/definition.ts';
import {
  conflict,
  hash,
  lineEnding,
  zones,
  type Zone,
  type BlockOwner,
  type Descriptor,
} from '#integration/ownership.ts';
import type { Workspace } from '#integration/workspace.ts';

type Contributions = Map<string, string[]>;
export type SourceRequests = Map<string, Map<Zone, Contributions>>;
type Kind = 'module' | 'target';
export function requestSource(
  catalog: CSharpRulesCatalog,
  doc: Descriptor,
  kind: Kind,
  edits: SourceEdit[],
  owner: string,
  requests: SourceRequests,
): void {
  if (!edits.length) return;
  const suffix = kind === 'module' ? '.Build.cs' : '.Target.cs';
  const files = catalog.sourceFiles().filter((file) => file.endsWith(suffix));
  const moduleNames = doc.Modules?.map((m) => m.Name) ?? [];
  const targetNames = files.map((f) => path.posix.basename(f, suffix));
  const valid = kind === 'module' ? moduleNames : targetNames;
  for (const edit of edits) {
    const names = edit.select === 'all' ? valid : edit.select;
    if (!names.length) throw new Error(`No ${kind}s in the workspace match the explicit all selector`);
    for (const name of new Set(names)) {
      const paths = files.filter((f) => path.posix.basename(f, suffix) === name);
      if (valid.filter((n) => n === name).length !== 1 || paths.length !== 1) {
        throw new Error(
          `Expected one workspace ${kind} named "${name}" and one matching ${suffix} file; found ${paths.length} candidate file(s).`,
        );
      }
      const file = paths[0];
      const fileRequests = requests.get(file) ?? new Map<Zone, Contributions>();
      requests.set(file, fileRequests);
      for (const zone of zones) {
        const code = edit[zone];
        if (!code) continue;
        const contributions = fileRequests.get(zone) ?? new Map<string, string[]>();
        const snippets = contributions.get(owner) ?? [];
        const normalized = code.replaceAll('\r\n', '\n');
        if (!snippets.includes(normalized)) snippets.push(normalized);
        contributions.set(owner, snippets);
        fileRequests.set(zone, contributions);
      }
    }
  }
}

function getMarker(catalog: CSharpRulesCatalog, source: string, zone: Zone, file: string, owned: boolean) {
  if (!source.includes('// UAPKG-')) return null;
  const bom = source.startsWith('\uFEFF') ? 1 : 0;
  const markers = catalog.analyzer.inspect(file, source).comments.flatMap((comment) => {
    const match = /^\/\/ UAPKG-(BEGIN|END) integration:(includes|classBody|constructorBody)[ \t]*$/.exec(
      source.slice(comment.start, comment.end),
    );
    if (!match) return [];
    const lineStart = Math.max(bom, source.lastIndexOf('\n', comment.start - 1) + 1);
    if (!/^[ \t]*$/.test(source.slice(lineStart, comment.start))) return [];
    return [{ ...comment, lineStart, side: match[1], zone: match[2] }];
  });
  const selected = markers.filter((marker) => marker.zone === zone);
  const active = selected.filter((marker) => marker.activity === 'active');
  if (selected.some((marker) => marker.activity === 'conditional') || (owned && selected.length && !active.length)) {
    throw new Error(
      `The ${zone} markers in ${file} are in disabled or conditionally compiled C# code. Restore their active placement before rerunning.`,
    );
  }
  if (!active.length) return null;
  const begin = active.filter((marker) => marker.side === 'BEGIN');
  const end = active.filter((marker) => marker.side === 'END');
  if (begin.length !== 1 || end.length !== 1 || begin[0].start >= end[0].start) {
    throw new Error(
      `Damaged or duplicate UAPKG markers for ${zone} in ${file}. Restore the marked region before rerunning.`,
    );
  }
  const start = begin[0].lineStart;
  const stop = end[0].end;
  if (
    markers.some(
      (marker) => marker.activity !== 'inactive' && marker.start > begin[0].start && marker.start < end[0].start,
    )
  ) {
    throw new Error(`Nested UAPKG markers in ${file}. Restore the marked region before rerunning.`);
  }
  return {
    start,
    end: stop,
    text: source.slice(start, stop),
    beginContainer: begin[0].containerStart,
    endContainer: end[0].containerStart,
  };
}

function rulesAnchors(catalog: CSharpRulesCatalog, file: string, source: string) {
  const isModule = file.endsWith('.Build.cs');
  return isModule
    ? catalog.analyzer.parseModule(
        file,
        source,
        (declaration) => catalog.derivesFrom(declaration, 'ModuleRules', file),
        catalog.isParameter,
      )
    : catalog.analyzer.parseTarget(
        file,
        source,
        (declaration) => catalog.derivesFrom(declaration, 'TargetRules', file),
        catalog.isParameter,
      );
}

function validateMarkerPlacement(
  catalog: CSharpRulesCatalog,
  file: string,
  source: string,
  zone: Zone,
  marker: { start: number; end: number; beginContainer: number | null; endContainer: number | null },
  replacement: string | null,
): void {
  const parsed = rulesAnchors(catalog, file, source);
  const container =
    zone === 'includes'
      ? null
      : zone === 'classBody'
        ? parsed.classInfo.classOpenBraceIndex
        : parsed.constructorInfo.bodyOpenBraceIndex;
  if (marker.beginContainer !== container || marker.endContainer !== container) {
    throw new Error(`Integration conflict in ${file}: the ${zone} markers have moved outside their original C# scope.`);
  }
  if (zone === 'includes' && replacement !== null) {
    const proposed = source.slice(0, marker.start) + replacement + source.slice(marker.end);
    const order = { extern: 0, global: 1, ordinary: 2 };
    let previous = 0;
    for (const { kind } of catalog.analyzer.inspect(file, proposed).directives) {
      if (order[kind] < previous) {
        throw new Error(
          `Integration conflict in ${file}: the includes block would put extern aliases or global usings out of order.`,
        );
      }
      previous = order[kind];
    }
  }
}

function insertion(catalog: CSharpRulesCatalog, source: string, file: string, zone: Zone) {
  const eol = lineEnding(source);
  const parsed = rulesAnchors(catalog, file, source);
  if (zone === 'includes') {
    const offset = parsed.includesOffset;
    const lineStart = Math.max(source.startsWith('\uFEFF') ? 1 : 0, source.lastIndexOf('\n', offset - 1) + 1);
    if (/^[ \t]*$/.test(source.slice(lineStart, offset))) {
      return { offset: lineStart, indent: '', prefix: '', suffix: eol };
    }
    return { offset, indent: '', prefix: eol, suffix: /^[\r\n]/.test(source.slice(offset)) ? '' : eol };
  }
  const brace = zone === 'classBody' ? parsed.classInfo.classOpenBraceIndex : parsed.constructorInfo.bodyOpenBraceIndex;
  const parentIndent = source.slice(source.lastIndexOf('\n', brace) + 1, brace).match(/^[ \t]*/)?.[0] ?? '';
  const indentUnit = source.match(/\n([ \t]+)\S/)?.[1] ?? '    ';
  return {
    offset: brace + 1,
    indent: parentIndent + indentUnit,
    prefix: eol,
    suffix: /^[\r\n]/.test(source.slice(brace + 1)) ? '' : eol,
  };
}

export function reconcileSource(
  ws: Workspace,
  catalog: CSharpRulesCatalog,
  file: string,
  old: BlockOwner[],
  requests: SourceRequests,
  retain: (owner: string) => boolean,
): BlockOwner[] {
  let source = ws.get(file);
  const remaining: BlockOwner[] = [];
  for (const zone of zones) {
    const previous = old.find((b) => b.zone === zone);
    const incoming = requests.get(file)?.get(zone) ?? new Map<string, string[]>();
    const merged = new Map<string, string[]>(
      previous?.contributions.filter((c) => retain(c.owner)).map((c) => [c.owner, c.snippets]),
    );
    for (const [owner, snippets] of incoming) merged.set(owner, snippets);
    const contributions = [...merged]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([owner, snippets]) => ({ owner, snippets }));
    if (!previous && !contributions.length) continue;
    if (source === null) {
      if (contributions.length) conflict(file, null, previous?.expected ?? contributions[0].snippets.join('\n'));
      continue;
    }
    const marker = getMarker(catalog, source, zone, file, !!previous);
    if (marker && !previous) conflict(file, marker.text, null);
    const position = contributions.length && !previous ? insertion(catalog, source, file, zone) : undefined;
    const indent = previous ? (previous.expected.match(/^[ \t]*/)?.[0] ?? '') : (position?.indent ?? '');
    const expected = contributions.length ? renderBlock(zone, indent, lineEnding(source), contributions, file) : null;
    const current = marker?.text ?? null;
    const prefix = previous?.prefix ?? position?.prefix ?? '';
    const suffix = previous?.suffix ?? position?.suffix ?? '';
    if (marker && previous && (current === previous.expected || current === expected)) {
      validateMarkerPlacement(catalog, file, source, zone, marker, expected);
    }
    if (current !== expected && (!previous || current === previous.expected)) {
      if (marker) {
        if (expected !== null) source = source.slice(0, marker.start) + expected + source.slice(marker.end);
        else {
          const start = source.slice(0, marker.start).endsWith(prefix) ? marker.start - prefix.length : marker.start;
          const end = source.slice(marker.end).startsWith(suffix) ? marker.end + suffix.length : marker.end;
          source = source.slice(0, start) + source.slice(end);
        }
      } else if (expected !== null && position) {
        source = source.slice(0, position.offset) + prefix + expected + suffix + source.slice(position.offset);
      }
    } else if (current !== expected && expected !== previous?.expected) conflict(file, current, expected);
    if (expected !== null)
      remaining.push({ file, zone, contributions, expected, fingerprint: hash(expected), prefix, suffix });
  }
  if (source !== null) ws.set(file, source);
  return remaining;
}
