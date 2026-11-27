import { configInkComponents } from '#diagnostics-format/ink/components/configInkComponents.tsx';
import { installerInkComponents } from '#diagnostics-format/ink/components/installerInkComponents.tsx';
import { manifestInkComponents } from '#diagnostics-format/ink/components/manifestInkComponents.tsx';
import { packInkComponents } from '#diagnostics-format/ink/components/packInkComponents.tsx';
import { publishingInkComponents } from '#diagnostics-format/ink/components/publishingInkComponents.tsx';
import { registryInkComponents } from '#diagnostics-format/ink/components/registryInkComponents.tsx';
import { resolverInkComponents } from '#diagnostics-format/ink/components/resolverInkComponents.tsx';
import { safetyInkComponents } from '#diagnostics-format/ink/components/safetyInkComponents.tsx';
import { specInkComponents } from '#diagnostics-format/ink/components/specInkComponents.tsx';
import type { DiagnosticInkComponentMap } from '#diagnostics-format/ink/contracts/InkTypes.ts';

/**
 * Aggregated default Ink component map — one entry per well-known diagnostic
 * code. Unknown codes fall back to {@link PlainTextBody} inside
 * {@link DiagnosticView}, so the registry is always safe to call.
 *
 * Consumers that want custom behavior can either:
 *
 *   1. Pass a spread: `{ ...defaultInkComponents, MY_CODE: MyBody }`, or
 *   2. Instantiate a {@link DiagnosticInkRegistry} and `.register()` after.
 */
export const defaultInkComponents: DiagnosticInkComponentMap = {
  ...configInkComponents,
  ...installerInkComponents,
  ...manifestInkComponents,
  ...packInkComponents,
  ...publishingInkComponents,
  ...registryInkComponents,
  ...resolverInkComponents,
  ...safetyInkComponents,
  ...specInkComponents,
};
