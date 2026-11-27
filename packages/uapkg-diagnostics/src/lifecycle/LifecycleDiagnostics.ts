import type { DiagnosticBase } from '#diagnostics/base/Diagnostic.ts';

export type LifecycleDiagnostic =
  | DiagnosticBase<
      'LIFECYCLE_APPROVAL_REQUIRED',
      {
        packageName: string;
        registry: string;
        version: string;
        capability: string;
        approveCommand: string;
        retryCommand: string;
      }
    >
  | DiagnosticBase<'LIFECYCLE_FAILED', { packageName?: string; capability?: string; retryCommand?: string }>;
