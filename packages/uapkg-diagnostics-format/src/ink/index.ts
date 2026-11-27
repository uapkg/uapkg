// ---------------------------------------------------------------------------
// @uapkg/diagnostics-format — Ink surface
//
// This is the "standardized component factory" subpath every consumer should
// import from when they want to render diagnostics as Ink elements.
//
// Plain-data helpers (formatters returning strings) remain exported from the
// package root; Ink helpers live here so consumers that don't ship a TTY UI
// pay zero React/Ink cost.
// ---------------------------------------------------------------------------

// Family component maps — exported individually so consumers can cherry-pick.
export { installerInkComponents } from '#diagnostics-format/ink/components/installerInkComponents.tsx';
export { manifestInkComponents } from '#diagnostics-format/ink/components/manifestInkComponents.tsx';
export { publishingInkComponents } from '#diagnostics-format/ink/components/publishingInkComponents.tsx';
export { registryInkComponents } from '#diagnostics-format/ink/components/registryInkComponents.tsx';
export { resolverInkComponents } from '#diagnostics-format/ink/components/resolverInkComponents.tsx';
export { safetyInkComponents } from '#diagnostics-format/ink/components/safetyInkComponents.tsx';
export { specInkComponents } from '#diagnostics-format/ink/components/specInkComponents.tsx';
export type {
  DiagnosticBodyComponent,
  DiagnosticBodyProps,
  DiagnosticInkComponentMap,
  IDiagnosticInkRegistry,
} from '#diagnostics-format/ink/contracts/InkTypes.ts';
export { defaultInkComponents } from '#diagnostics-format/ink/defaults/defaultInkComponents.ts';
// Primitives.
export { HintLine } from '#diagnostics-format/ink/primitives/HintLine.tsx';
export { PlainTextBody } from '#diagnostics-format/ink/primitives/PlainTextBody.tsx';
export { SeverityBadge } from '#diagnostics-format/ink/primitives/SeverityBadge.tsx';
export { createInkRegistry, DiagnosticInkRegistry } from '#diagnostics-format/ink/registry/DiagnosticInkRegistry.ts';
export {
  DiagnosticsListView,
  type DiagnosticsListViewProps,
} from '#diagnostics-format/ink/views/DiagnosticsListView.tsx';
// Views.
export { DiagnosticView, type DiagnosticViewProps } from '#diagnostics-format/ink/views/DiagnosticView.tsx';
