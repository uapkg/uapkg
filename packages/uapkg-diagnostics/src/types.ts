import type { ConfigDiagnostic } from '#diagnostics/config/ConfigDiagnostics.ts';
import type { ControlPlaneDiagnostic } from '#diagnostics/controlPlane/ControlPlaneDiagnostics.ts';
import type { GeneralDiagnostic } from '#diagnostics/general/GeneralDiagnostics.ts';
import type { InstallerDiagnostic } from '#diagnostics/installer/InstallerDiagnostics.ts';
import type { ManifestDiagnostic } from '#diagnostics/manifest/ManifestDiagnostics.ts';
import type { PackDiagnostic } from '#diagnostics/pack/PackDiagnostics.ts';
import type { LifecycleDiagnostic } from '#diagnostics/lifecycle/LifecycleDiagnostics.ts';
import type { PublishingDiagnostic } from '#diagnostics/publishing/PublishingDiagnostics.ts';
import type { RegistryDiagnostic } from '#diagnostics/registry/RegistryDiagnostics.ts';
import type { RegistryToolsDiagnostic } from '#diagnostics/registryTools/RegistryToolsDiagnostics.ts';
import type { ResolverDiagnostic } from '#diagnostics/resolver/ResolverDiagnostics.ts';
import type { SafetyDiagnostic } from '#diagnostics/safety/SafetyDiagnostics.ts';
import type { SpecParseDiagnostic } from '#diagnostics/spec/SpecDiagnostics.ts';

/**
 * The unified Diagnostic type — a discriminated union of every known
 * diagnostic, keyed on `code`.
 *
 * To add a new diagnostic:
 *   1. Create its type in the appropriate family file.
 *   2. Add it to that family's union.
 *   3. It is automatically part of `Diagnostic` through this re-export.
 */
export type Diagnostic =
  | ResolverDiagnostic
  | ControlPlaneDiagnostic
  | ConfigDiagnostic
  | RegistryDiagnostic
  | RegistryToolsDiagnostic
  | ManifestDiagnostic
  | PackDiagnostic
  | GeneralDiagnostic
  | InstallerDiagnostic
  | LifecycleDiagnostic
  | PublishingDiagnostic
  | SafetyDiagnostic
  | SpecParseDiagnostic;

/**
 * Extract a specific diagnostic by code.
 *
 * @example
 * type VC = DiagnosticByCode<'VERSION_CONFLICT'>;
 */
export type DiagnosticByCode<C extends Diagnostic['code']> = Extract<Diagnostic, { code: C }>;

/** All known diagnostic codes. */
export type DiagnosticCode = Diagnostic['code'];
