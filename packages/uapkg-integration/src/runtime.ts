import { prepareIntegration } from '#integration/reconcile.ts';
import type { IntegrationInput } from '#integration/definition.ts';

export { integrationAuthorModule } from '#integration/author.ts';
export { IntegrationDefinitionSchema, type IntegrationDefinition } from '#integration/definition.ts';

/** CLI entry point: descriptor-only operations never need to initialize the C# grammar. */
export async function reconcileWorkspaceIntegration(input: IntegrationInput): Promise<{ changedFiles: string[] }> {
  const plan = prepareIntegration(input);
  return plan.commit(
    plan.needsSource ? (await import('#integration/applySourceIntegration.ts')).applySourceIntegration : undefined,
  );
}
