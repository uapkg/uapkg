// ---------------------------------------------------------------------------
// @uapkg/installer — public API
// ---------------------------------------------------------------------------

// Contracts
export type {
  InstallAction,
  InstallActionType,
  InstallerOptions,
  InstallPlan,
  InstallReport,
  InstallSummary,
  PackageInstallOutcome,
  PackageInstallStatus,
  VerifiedRelease,
} from '#installer/contracts/InstallerTypes.ts';
export type {
  BuiltInSafetyPolicyId,
  SafetyContext,
  SafetyEvaluation,
  SafetyPolicy,
} from '#installer/contracts/SafetyPolicyTypes.ts';
export type {
  DownloadStatusSnapshot,
  InstallTotals,
  SlotSnapshot,
  SlotState,
} from '#installer/contracts/StatusStreamTypes.ts';

// Core
export { type ClaimsVerificationInput, ClaimsVerifier } from '#installer/core/ClaimsVerifier.ts';
export { type DiskStateEntry, DiskStateInspector } from '#installer/core/DiskStateInspector.ts';
export { Installer, type InstallerConstructorOptions } from '#installer/core/Installer.ts';
export { InstallPlanner } from '#installer/core/InstallPlanner.ts';
export { IntegrityVerifier } from '#installer/core/IntegrityVerifier.ts';
export {
  type DownloadOptions,
  type DownloadProgress,
  type DownloadResult,
  PackageDownloader,
} from '#installer/core/PackageDownloader.ts';
export { PackageExtractor } from '#installer/core/PackageExtractor.ts';
export { PackageRemover } from '#installer/core/PackageRemover.ts';

// Safety
export { NoMarkerPolicy } from '#installer/safety/NoMarkerPolicy.ts';
export { SafetyPolicyRegistry, type SafetyVerdict } from '#installer/safety/SafetyPolicyRegistry.ts';

// Status
export { SlotTable } from '#installer/status/SlotTable.ts';
export { StatusStream } from '#installer/status/StatusStream.ts';
