import { CSharpRulesCatalog } from '#integration/CSharpRulesCatalog.ts';
import type { IntegrationInput } from '#integration/definition.ts';
import type { BlockOwner, Descriptor } from '#integration/ownership.ts';
import { reconcileSource, requestSource, type SourceRequests } from '#integration/source.ts';
import type { Workspace } from '#integration/workspace.ts';

export function applySourceIntegration(
  workspace: Workspace,
  descriptor: Descriptor | undefined,
  host: IntegrationInput['integrations'],
  prior: BlockOwner[],
  retain: (owner: string) => boolean,
): BlockOwner[] {
  const catalog = new CSharpRulesCatalog(workspace);
  const requests: SourceRequests = new Map();
  if (descriptor) {
    for (const { owner, definition } of host) {
      requestSource(catalog, descriptor, 'module', definition.setupModules ?? [], owner, requests);
      requestSource(catalog, descriptor, 'target', definition.setupTargets ?? [], owner, requests);
    }
  }
  const files = new Set([...prior.map((block) => block.file), ...requests.keys()]);
  return [...files].sort().flatMap((file) =>
    reconcileSource(
      workspace,
      catalog,
      file,
      prior.filter((block) => block.file === file),
      requests,
      retain,
    ),
  );
}
