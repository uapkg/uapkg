// ---------------------------------------------------------------------------
// @uapkg/uapkg — public API
//
// Phase 8 + Phase 10 final surface. Legacy exports (`UAPKGManifest`,
// `FileManifestRepository`, `DependencyGraphBuilder`, `TOMLLockfileRepository`,
// `DependencyInstaller`, `SafetyPolicy`, etc.) were removed in Phase 10; use
// `@uapkg/package-manifest` + `@uapkg/package-manifest-schema` instead.
// ---------------------------------------------------------------------------

// Application dispatcher + composition root
export { CompositionRoot, type CompositionRootOptions } from '#cli/app/CompositionRoot.ts';
export { UAPKGApplication } from '#cli/app/UAPKGApplication.ts';

// CLI
export { parseUAPKGCommandLine } from '#cli/cli/parseCommandLine.ts';
export { runUAPKGCLI } from '#cli/cli/runUAPKGCLI.ts';
export type { UAPKGCommandLine, UAPKGWhoamiField } from '#cli/cli/UAPKGCommandLine.ts';
export {
  createUAPKGCommandLineFactory,
  UAPKG_WHOAMI_FIELDS,
  UAPKGCommandLineFactory,
} from '#cli/cli/UAPKGCommandLine.ts';
// Commands — new surface
export { AddCommand, type AddCommandOptions } from '#cli/commands/AddCommand.ts';
// Commands — retained, ported onto CompositionRoot in Phase 10
export { ConfigCommand } from '#cli/commands/ConfigCommand.ts';
export { InitCommand, type InitCommandOptions } from '#cli/commands/InitCommand.ts';
export { InstallCommand, type InstallCommandOptions } from '#cli/commands/InstallCommand.ts';
export { ListCommand, type ListCommandOptions } from '#cli/commands/ListCommand.ts';
export { LoginCommand, type LoginCommandOptions } from '#cli/commands/LoginCommand.ts';
export { LogoutCommand, type LogoutCommandOptions } from '#cli/commands/LogoutCommand.ts';
export { OutdatedCommand, type OutdatedCommandOptions } from '#cli/commands/OutdatedCommand.ts';
export { PackCommand } from '#cli/commands/PackCommand.ts';
export { ProjectGetNameCommand, type ProjectGetNameCommandOptions } from '#cli/commands/ProjectGetNameCommand.ts';
export { PublishCommand, type PublishCommandOptions } from '#cli/commands/PublishCommand.ts';
export {
  RegistryCommand,
  type RegistryCommandOptions,
  type RegistryCommandRuntime,
} from '#cli/commands/RegistryCommand.ts';
export { RemoveCommand, type RemoveCommandOptions } from '#cli/commands/RemoveCommand.ts';
export { RequestsCommand, type RequestsCommandOptions } from '#cli/commands/RequestsCommand.ts';
export { UpdateCommand, type UpdateCommandOptions } from '#cli/commands/UpdateCommand.ts';
export {
  WhoamiCommand,
  type WhoamiCommandData,
  type WhoamiCommandOptions,
  type WhoamiFieldData,
} from '#cli/commands/WhoamiCommand.ts';
export { WhyCommand, type WhyCommandOptions } from '#cli/commands/WhyCommand.ts';
// Control-plane authentication
export {
  type AccessCredential,
  AccountManager,
  type BrowserOpener,
  controlPlaneDiagnosticForError,
  describeControlPlaneError,
  LoginError,
  type LoginOptions,
  type LoginProgressEvent,
  type LoginResult,
  loginDiagnosticForError,
} from '#cli/control-plane/AccountManager.ts';
export { AuthMetadataStore } from '#cli/control-plane/AuthMetadataStore.ts';
export { ControlPlaneClient, type ControlPlaneCredential } from '#cli/control-plane/ControlPlaneClient.ts';
export * from '#cli/control-plane/ControlPlaneTypes.ts';
export { CredentialStore, type KeyringLoader } from '#cli/control-plane/CredentialStore.ts';
export { DPoPKeyStore } from '#cli/control-plane/DPoPKeyStore.ts';
export {
  FileRegistryGrantLock,
  type FileRegistryGrantLockOptions,
  type RegistryGrantLock,
} from '#cli/control-plane/RegistryGrantLock.ts';
export {
  canonicalizeRegistryGitOrigin,
  fingerprintRegistryGitOrigin,
  RegistryTrustResolver,
} from '#cli/control-plane/RegistryTrustResolver.ts';
// Prompt abstractions (used by init)
export { InkPromptService } from '#cli/prompts/InkPromptService.tsx';
export { type ProjectContextDetection, ProjectContextDetector } from '#cli/prompts/ProjectContextDetector.ts';
export type { PromptService, SelectOption } from '#cli/prompts/PromptService.ts';
// Reporting
export { DiagnosticReporter } from '#cli/reporting/DiagnosticReporter.ts';
export { InstallProgressReporter } from '#cli/reporting/InstallProgressReporter.ts';
export { type JsonEnvelope, JsonReporter } from '#cli/reporting/JsonReporter.ts';
