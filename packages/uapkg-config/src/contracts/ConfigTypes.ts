import type { Diagnostic } from '@uapkg/diagnostics';
import type {
  PartialConfig,
  LifecyclePolicyValue,
  RegistryConfig,
  RegistryRef,
  ResolvedConfig,
} from '#config/schema/configSchema.ts';

export type ConfigLayerSource = 'default' | 'global' | 'intermediary' | 'local';

export type ConfigValue = unknown;

export interface ConfigLayer {
  source: ConfigLayerSource;
  file?: string;
  values: Record<string, unknown>;
  /** Whole-file read failures are retained for tracing ignored overrides. */
  ignoredReason?: string;
}

export interface ConfigValueWithOrigin {
  value: ConfigValue;
  source: ConfigLayerSource;
  file?: string;
}

export interface ConfigTraceEntry {
  source: ConfigLayerSource;
  value: ConfigValue;
  file?: string;
  status?: 'accepted' | 'ignored';
  reason?: string;
}

export type ConfigScope = 'global' | 'local';

export interface ConfigReloadOptions {
  cwd?: string;
}

export interface ConfigCreateOptions {
  cwd?: string;
}

export interface ConfigGetOptions {
  scope?: ConfigScope;
}

export interface ConfigListOptions {
  scope?: ConfigScope;
}

export interface ConfigWriteOptions {
  scope?: ConfigScope;
}

export interface ConfigPaths {
  cwd: string;
  manifestRoot: string;
  globalFile: string;
  localFile: string;
  intermediaryFiles: string[];
}

export interface ConfigReadResult {
  values: Record<string, unknown>;
  exists: boolean;
  diagnostics: readonly Diagnostic[];
}

export interface ConfigLayerBuildResult {
  layers: ConfigLayer[];
  diagnostics: readonly Diagnostic[];
}

export interface ConfigResolvedResult {
  value: Record<string, unknown>;
  diagnostics: readonly Diagnostic[];
}

export type { PartialConfig, LifecyclePolicyValue, RegistryConfig, RegistryRef, ResolvedConfig };
