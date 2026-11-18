import type { DiagnosticBase } from '#diagnostics/base/Diagnostic.ts';

/** A config file contains invalid JSON and could not be parsed. */
export type ConfigInvalidJsonDiagnostic = DiagnosticBase<
  'CONFIG_INVALID_JSON',
  {
    readonly filePath: string;
    readonly reason: string;
  }
>;

/** Config value type is incompatible with expected merge shape. */
export type ConfigTypeMismatchDiagnostic = DiagnosticBase<
  'CONFIG_TYPE_MISMATCH',
  {
    readonly path: string;
    readonly expectedType: string;
    readonly actualType: string;
    readonly source: string;
    readonly filePath?: string;
  }
>;

/** Unknown config key encountered in a config layer. */
export type ConfigUnknownKeyDiagnostic = DiagnosticBase<
  'CONFIG_UNKNOWN_KEY',
  {
    readonly path: string;
    readonly source: string;
    readonly filePath?: string;
  }
>;

/** Cross-field semantic mismatch: default registry not defined in registries map. */
export type ConfigUnresolvedDefaultRegistryDiagnostic = DiagnosticBase<
  'CONFIG_UNRESOLVED_DEFAULT_REGISTRY',
  {
    readonly registryName: string;
  }
>;

/** Value failed a narrower semantic validation rule. */
export type ConfigInvalidValueDiagnostic = DiagnosticBase<
  'CONFIG_INVALID_VALUE',
  {
    readonly path: string;
    readonly rule: string;
    readonly source?: string;
    readonly filePath?: string;
    readonly ignored?: boolean;
  }
>;

/** Union of all config diagnostics. */
export type ConfigDiagnostic =
  | ConfigInvalidJsonDiagnostic
  | ConfigTypeMismatchDiagnostic
  | ConfigUnknownKeyDiagnostic
  | ConfigUnresolvedDefaultRegistryDiagnostic
  | ConfigInvalidValueDiagnostic;

export function createConfigInvalidJsonDiagnostic(filePath: string, reason: string): ConfigInvalidJsonDiagnostic {
  return {
    level: 'warning',
    code: 'CONFIG_INVALID_JSON',
    message: `Ignoring invalid JSON in config file "${filePath}".`,
    hint: 'Fix JSON syntax in this file to restore those settings.',
    data: { filePath, reason },
  };
}

export function createConfigTypeMismatchDiagnostic(input: {
  readonly path: string;
  readonly expectedType: string;
  readonly actualType: string;
  readonly source: string;
  readonly filePath?: string;
}): ConfigTypeMismatchDiagnostic {
  return {
    level: 'warning',
    code: 'CONFIG_TYPE_MISMATCH',
    message: `Ignoring config value at "${input.path}" because it is ${input.actualType}, expected ${input.expectedType}.`,
    hint: 'Use a value type compatible with this config key.',
    data: input,
  };
}

export function createConfigUnknownKeyDiagnostic(input: {
  readonly path: string;
  readonly source: string;
  readonly filePath?: string;
}): ConfigUnknownKeyDiagnostic {
  return {
    level: 'warning',
    code: 'CONFIG_UNKNOWN_KEY',
    message: `Ignoring unknown config key "${input.path}".`,
    hint: 'Remove or rename this key to a supported configuration path.',
    data: input,
  };
}

export function createConfigUnresolvedDefaultRegistryDiagnostic(
  registryName: string,
): ConfigUnresolvedDefaultRegistryDiagnostic {
  return {
    level: 'warning',
    code: 'CONFIG_UNRESOLVED_DEFAULT_REGISTRY',
    message: `Default registry "${registryName}" is not defined under "registries".`,
    emitPolicy: 'once',
    hint: `Add "registries.${registryName}" or set a different default with 'uapkg registry use <name>'.`,
    data: { registryName },
  };
}

export function createConfigInvalidValueDiagnostic(
  path: string,
  rule: string,
  context?: { source: string; filePath?: string; ignored: boolean },
): ConfigInvalidValueDiagnostic {
  return {
    level: 'warning',
    code: 'CONFIG_INVALID_VALUE',
    message: context?.ignored
      ? `Ignored "${path}" in ${context.source} config${context.filePath ? ` "${context.filePath}"` : ''}: ${rule}.`
      : `Config value at "${path}" may be invalid: ${rule}.`,
    hint: 'Update this value to match the expected format for this key.',
    data: { path, rule, ...context },
  };
}
