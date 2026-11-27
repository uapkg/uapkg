export { defineIntegration, integrationAuthorModule } from '#integration/author.ts';
export { IntegrationDefinitionSchema } from '#integration/definition.ts';
export type { IntegrationDefinition, IntegrationInput, SourceEdit } from '#integration/definition.ts';
import { prepareIntegration } from '#integration/reconcile.ts';
import { applySourceIntegration } from '#integration/applySourceIntegration.ts';
import type { IntegrationInput } from '#integration/definition.ts';

export function reconcileIntegration(input: IntegrationInput): { changedFiles: string[] } {
  return prepareIntegration(input).commit(applySourceIntegration);
}
