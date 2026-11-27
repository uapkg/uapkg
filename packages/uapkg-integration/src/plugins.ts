import { pluginName } from '#integration/definition.ts';
import { conflict, hash, type Descriptor, type PluginOwner, type PluginRef } from '#integration/ownership.ts';

export function reconcilePlugins(
  file: string,
  doc: Descriptor,
  old: PluginOwner[],
  requests: ReadonlyMap<string, Set<string>>,
  retain: (owner: string) => boolean,
) {
  const plugins = doc.Plugins ?? [];
  const createdList = !doc.Plugins || old.some((o) => o.createdList);
  const names = new Set([...old.map((o) => o.name), ...requests.keys()]);
  const remaining: PluginOwner[] = [];
  let changed = false;
  const folded = new Set<string>();
  for (const name of [...names].sort()) {
    pluginName.parse(name);
    if (folded.has(name.toLowerCase())) throw new Error(`Ambiguous Unreal plugin spelling in ${file}: ${name}`);
    folded.add(name.toLowerCase());
    const previous = old.find((o) => o.name === name);
    const owners = [...new Set([...(requests.get(name) ?? []), ...(previous?.owners.filter(retain) ?? [])])].sort();
    const entries = plugins.filter((p) => p.Name.toLowerCase() === name.toLowerCase());
    if (entries.length > 1 || (entries[0] && entries[0].Name !== name))
      throw new Error(`Ambiguous Unreal plugin reference in ${file}: ${name}`);
    const entry = entries[0];
    const prior = previous ? previous.prior : entry ? { ...entry } : null;
    if (owners.length) {
      if (entry?.Enabled === false) conflict(file, JSON.stringify(entry), JSON.stringify({ ...entry, Enabled: true }));
      if (!entry) {
        if (previous) conflict(file, null, JSON.stringify({ Name: name, Enabled: true }));
        plugins.push({ Name: name, Enabled: true });
        changed = true;
      } else if (entry.Enabled !== true) {
        entry.Enabled = true;
        changed = true;
      }
      const expected = { ...(prior ?? { Name: name }), Enabled: true };
      remaining.push({ file, name, owners, prior, fingerprint: hash(JSON.stringify(expected)), createdList });
      continue;
    }
    if (!previous || !entry || prior?.Enabled === true) continue;
    if (prior === null) {
      if (entry.Enabled !== true || Object.keys(entry).some((k) => k !== 'Name' && k !== 'Enabled')) {
        conflict(file, JSON.stringify(entry), null);
      }
      plugins.splice(plugins.indexOf(entry), 1);
    } else {
      if (entry.Enabled === prior.Enabled) continue;
      if (entry.Enabled !== true) conflict(file, JSON.stringify(entry), JSON.stringify(prior));
      restoreEnabled(entry, prior);
    }
    changed = true;
  }
  if (changed) {
    if (!plugins.length && createdList) delete doc.Plugins;
    else doc.Plugins = plugins;
  }
  return { remaining, changed };
}
function restoreEnabled(entry: PluginRef, prior: PluginRef): void {
  if (prior.Enabled === undefined) delete entry.Enabled;
  else entry.Enabled = prior.Enabled;
}
