import type { IntegrationDefinition } from '#integration/definition.ts';

/** Keep the author helper self-contained so the CLI can supply it inside verified package workers. */
export function defineIntegration(definition: IntegrationDefinition): IntegrationDefinition {
  return definition;
}

export const integrationAuthorModule = `export const defineIntegration = ${defineIntegration.toString()};`;
