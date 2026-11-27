import fs from 'node:fs';
import type { applySourceIntegration } from '#integration/applySourceIntegration.ts';
import { IntegrationDefinitionSchema, type IntegrationInput } from '#integration/definition.ts';
import { hash, ownership, readDescriptor, type Descriptor, type Ownership } from '#integration/ownership.ts';
import { writeDescriptor } from '#integration/descriptorText.ts';
import { reconcilePlugins } from '#integration/plugins.ts';
import { ownershipFile, Workspace } from '#integration/workspace.ts';

function currentOwnership(ws: Workspace): Ownership {
  const raw = ws.get(ownershipFile);
  if (raw === null) return { version: 1, plugins: [], blocks: [] };
  const ledger = ownership.parse(JSON.parse(raw));
  const keys = new Set<string>();
  for (const ref of ledger.plugins) {
    if (!/^[^/\\:]+\.u(?:plugin|project)$/i.test(ref.file))
      throw new Error(`Invalid descriptor in ${ownershipFile}: ${ref.file}`);
    const key = JSON.stringify([ref.file, ref.name.toLowerCase()]);
    if (
      keys.has(key) ||
      (ref.prior && ref.prior.Name !== ref.name) ||
      ref.fingerprint !== hash(JSON.stringify({ ...(ref.prior ?? { Name: ref.name }), Enabled: true }))
    ) {
      throw new Error(`Invalid plugin ownership in ${ownershipFile}: ${ref.name}`);
    }
    keys.add(key);
  }
  for (const block of ledger.blocks) {
    const key = JSON.stringify([block.file, block.zone]);
    if (
      keys.has(key) ||
      !/^Source\/.+\.(?:Build|Target)\.cs$/.test(block.file) ||
      block.fingerprint !== hash(block.expected) ||
      !/^([\r]?\n)?$/.test(block.prefix) ||
      !/^([\r]?\n)?$/.test(block.suffix)
    )
      throw new Error(`Invalid block ownership in ${ownershipFile}: ${block.file}`);
    ws.path(block.file);
    keys.add(key);
  }
  return ledger;
}

function descriptorFile(ws: Workspace, kind: IntegrationInput['workspaceKind']): string {
  const suffix = kind === 'project' ? '.uproject' : '.uplugin';
  const roots = fs
    .readdirSync(ws.root, { withFileTypes: true })
    .filter((entry) => entry.name.toLowerCase().endsWith(suffix));
  if (roots.length !== 1 || !roots[0].isFile())
    throw new Error(`Expected one root ${suffix} descriptor in ${ws.root}; found ${roots.length}.`);
  return roots[0].name;
}

export function prepareIntegration(input: IntegrationInput) {
  const ws = new Workspace(input.workspaceRoot, input.installedRoots);
  const prior = currentOwnership(ws);
  const next: Ownership = { version: 1, plugins: [], blocks: [] };
  const retained = new Set(input.retainOwners);
  const retain = (owner: string) => !input.complete || retained.has(owner);
  let descriptor: Descriptor | undefined;
  const plugins = new Map<string, Set<string>>();
  function addPlugin(name: string, owner: string): void {
    const owners = plugins.get(name) ?? new Set<string>();
    owners.add(owner);
    plugins.set(name, owners);
  }
  const directSources = new Map<string, string>();
  for (const direct of input.directPlugins) {
    const id = direct.pluginName.toLowerCase();
    const previous = directSources.get(id);
    if (previous && previous !== direct.owner) {
      throw new Error(
        `Two direct packages provide the same Unreal plugin '${direct.pluginName}': ${previous} and ${direct.owner}.`,
      );
    }
    directSources.set(id, direct.owner);
    addPlugin(direct.pluginName, direct.owner);
  }
  const host =
    input.workspaceKind === 'project'
      ? input.integrations.map(({ owner, definition }) => ({
          owner,
          definition: IntegrationDefinitionSchema.parse(definition),
        }))
      : [];
  for (const entry of host)
    for (const name of entry.definition.setupProject?.plugins ?? []) addPlugin(name, entry.owner);
  const hasSource = host.some(({ definition }) => definition.setupModules?.length || definition.setupTargets?.length);
  const active = plugins.size || hasSource ? descriptorFile(ws, input.workspaceKind) : undefined;
  const files = new Set(prior.plugins.map((o) => o.file));
  if (active) files.add(active);
  for (const file of [...files].sort()) {
    const original = ws.get(file);
    const old = prior.plugins.filter((p) => p.file === file);
    if (original === null) {
      if (old.some((o) => o.owners.some(retain))) next.plugins.push(...old);
      continue;
    }
    const doc = readDescriptor(original);
    const result = reconcilePlugins(file, doc, old, file === active ? plugins : new Map(), retain);
    next.plugins.push(...result.remaining);
    if (result.changed) ws.set(file, writeDescriptor(original, doc));
    if (file === active) descriptor = doc;
  }
  const needsSource = hasSource || prior.blocks.length > 0;
  return {
    needsSource,
    commit(editSource?: typeof applySourceIntegration): { changedFiles: string[] } {
      if (needsSource) {
        if (!editSource) throw new Error('The C# source editor is required to reconcile these integration blocks.');
        next.blocks.push(...editSource(ws, descriptor, host, prior.blocks, retain));
      }
      if (next.plugins.length || next.blocks.length) ws.set(ownershipFile, JSON.stringify(next, null, 2) + '\n');
      else if (ws.get(ownershipFile) !== null) ws.set(ownershipFile, null);
      return { changedFiles: ws.commit() };
    },
  };
}
