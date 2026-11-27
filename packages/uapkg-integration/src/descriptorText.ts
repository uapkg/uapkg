import type { Descriptor, PluginRef } from '#integration/ownership.ts';

interface Member {
  start: number;
  value: number;
  end: number;
  key?: string;
}
interface Container {
  open: number;
  close: number;
  members: Member[];
}

/** Index one already-validated JSON container. Offsets point into the original text, including its BOM. */
function index(source: string): Container {
  const tokens = [...source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}[\],:]|[^\s{}[\],:]+/g)];
  const object = tokens[0][0] === '{';
  const members: Member[] = [];
  let i = 1;
  while (i < tokens.length - 1) {
    const start = tokens[i].index;
    let key: string | undefined;
    if (object) {
      key = JSON.parse(tokens[i][0]);
      i += 2;
    }
    const value = tokens[i].index;
    let depth = 0;
    do {
      const token = tokens[i++][0];
      if (token === '{' || token === '[') depth++;
      if (token === '}' || token === ']') depth--;
    } while (depth);
    const last = tokens[i - 1];
    members.push({ start, key, value, end: last.index + last[0].length });
    if (tokens[i]?.[0] === ',') i++;
  }
  return { open: tokens[0].index, close: tokens.at(-1)!.index, members };
}
function replace(source: string, start: number, end: number, text: string): string {
  return source.slice(0, start) + text + source.slice(end);
}
function remove(source: string, container: Container, at: number): string {
  const item = container.members[at];
  const next = container.members[at + 1];
  if (next) return replace(source, item.start, next.start, '');
  const prev = container.members[at - 1];
  return replace(source, prev?.end ?? item.start, item.end, '');
}
function append(source: string, container: Container, value: string): string {
  const prev = container.members.at(-1);
  if (!prev) return replace(source, container.open + 1, container.open + 1, value);
  const leading = source.slice(container.open + 1, container.members[0].start);
  const indent = source.slice(source.lastIndexOf('\n', prev.start) + 1, prev.start);
  const separator =
    leading.includes('\n') && /^[ \t]*$/.test(indent)
      ? (source.includes('\r\n') ? '\r\n' : '\n') + indent
      : leading || (source.includes(', ') ? ' ' : '');
  return replace(source, prev.end, prev.end, ',' + separator + value);
}
function setMember(source: string, key: string, value: string | null): string {
  const container = index(source);
  const items = container.members.filter((m) => m.key === key);
  if (items.length > 1) throw new Error(`Ambiguous Unreal descriptor contains duplicate "${key}" fields`);
  const item = items[0];
  if (item)
    return value === null
      ? remove(source, container, container.members.indexOf(item))
      : replace(source, item.value, item.end, value);
  if (value === null) return source;
  const prev = container.members.at(-1);
  const sep = prev ? (source.slice(prev.start, prev.value).match(/(\s*:\s*)$/)?.[1] ?? ': ') : ': ';
  return append(source, container, JSON.stringify(key) + sep + value);
}

/** Change just Plugins and its Enabled values. Other fields keep their original order, escapes, spacing and line endings. */
export function writeDescriptor(original: string, doc: Descriptor): string {
  const root = index(original);
  const field = root.members.find((m) => m.key === 'Plugins');
  if (!doc.Plugins) return setMember(original, 'Plugins', null);
  let array = field ? original.slice(field.value, field.end) : '[]';
  const desired = new Map(doc.Plugins.map((entry) => [entry.Name, entry]));
  const present = new Set<string>();
  const initial = index(array);
  for (let i = initial.members.length - 1; i >= 0; i--) {
    const member = initial.members[i];
    const raw = array.slice(member.value, member.end);
    const old = JSON.parse(raw) as PluginRef;
    const current = desired.get(old.Name);
    if (!current) {
      array = remove(array, index(array), i);
    } else {
      present.add(old.Name);
      if (old.Enabled !== current.Enabled) {
        const patched = setMember(
          raw,
          'Enabled',
          current.Enabled === undefined ? null : JSON.stringify(current.Enabled),
        );
        array = replace(array, member.value, member.end, patched);
      }
    }
  }
  for (const entry of doc.Plugins) {
    if (!present.has(entry.Name)) array = append(array, index(array), JSON.stringify(entry));
  }
  return setMember(original, 'Plugins', array);
}
