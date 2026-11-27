import type { FormatterMap } from '#diagnostics-format/contracts/FormatterTypes.ts';
import { configFormatters } from '#diagnostics-format/formatters/config/configFormatters.ts';
import { installerFormatters } from '#diagnostics-format/formatters/installer/installerFormatters.ts';
import { manifestFormatters } from '#diagnostics-format/formatters/manifest/manifestFormatters.ts';
import { packFormatters } from '#diagnostics-format/formatters/pack/packFormatters.ts';
import { publishingFormatters } from '#diagnostics-format/formatters/publishing/publishingFormatters.ts';
import { registryFormatters } from '#diagnostics-format/formatters/registry/registryFormatters.ts';
import { registryToolsFormatters } from '#diagnostics-format/formatters/registryTools/registryToolsFormatters.ts';
import { resolverFormatters } from '#diagnostics-format/formatters/resolver/resolverFormatters.ts';
import { safetyFormatters } from '#diagnostics-format/formatters/safety/safetyFormatters.ts';
import { specFormatters } from '#diagnostics-format/formatters/spec/specFormatters.ts';

/**
 * Merged map of all built-in formatters across families.
 */
export const defaultFormatters: FormatterMap = {
  ...resolverFormatters,
  ...configFormatters,
  ...registryFormatters,
  ...registryToolsFormatters,
  ...manifestFormatters,
  ...packFormatters,
  ...installerFormatters,
  ...publishingFormatters,
  ...safetyFormatters,
  ...specFormatters,
};
