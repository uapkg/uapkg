// ---------------------------------------------------------------------------
// @uapkg/diagnostics-format — public API
// ---------------------------------------------------------------------------

export type {
  DiagnosticFormatterFn,
  FormatterMap,
  IFormatterRegistry,
} from '#diagnostics-format/contracts/FormatterTypes.ts';
export { defaultFormatters } from '#diagnostics-format/defaults/defaultFormatters.ts';
export { installerFormatters } from '#diagnostics-format/formatters/installer/installerFormatters.ts';
export { manifestFormatters } from '#diagnostics-format/formatters/manifest/manifestFormatters.ts';
export { formatPlainText } from '#diagnostics-format/formatters/PlainTextFormatter.ts';
export {
  formatPublishRequestFailed,
  publishingFormatters,
} from '#diagnostics-format/formatters/publishing/publishingFormatters.ts';
export { registryFormatters } from '#diagnostics-format/formatters/registry/registryFormatters.ts';
export { registryToolsFormatters } from '#diagnostics-format/formatters/registryTools/registryToolsFormatters.ts';
export { resolverFormatters } from '#diagnostics-format/formatters/resolver/resolverFormatters.ts';
export { safetyFormatters } from '#diagnostics-format/formatters/safety/safetyFormatters.ts';
export { specFormatters } from '#diagnostics-format/formatters/spec/specFormatters.ts';
export { createFormatterRegistry, FormatterRegistry } from '#diagnostics-format/registry/FormatterRegistry.ts';
export { bulletList, indent } from '#diagnostics-format/utils/indent.ts';
