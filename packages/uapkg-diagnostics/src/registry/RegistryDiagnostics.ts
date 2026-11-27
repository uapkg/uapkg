import type { DiagnosticBase } from '#diagnostics/base/Diagnostic.ts';

// ---------------------------------------------------------------------------
// Registry diagnostic codes
// ---------------------------------------------------------------------------

/** A network-level error when communicating with a registry. */
export type NetworkErrorDiagnostic = DiagnosticBase<
  'NETWORK_ERROR',
  {
    readonly url: string;
    readonly reason: string;
  }
>;

/** A git operation failed. */
export type GitErrorDiagnostic = DiagnosticBase<
  'GIT_ERROR',
  {
    readonly command: string;
    readonly stderr: string;
    readonly exitCode: number;
  }
>;

/** A registry document did not pass schema validation. */
export type SchemaInvalidDiagnostic = DiagnosticBase<
  'SCHEMA_INVALID',
  {
    readonly filePath: string;
    readonly issues: readonly string[];
  }
>;

/** A referenced registry name is not found in configuration. */
export type RegistryNotFoundDiagnostic = DiagnosticBase<
  'REGISTRY_NOT_FOUND',
  {
    readonly registryName: string;
  }
>;

export type PackageRegistryAmbiguousDiagnostic = DiagnosticBase<
  'PACKAGE_REGISTRY_AMBIGUOUS',
  { readonly packageName: string; readonly registries: readonly string[] }
>;

/** Failed to acquire the registry update lock. */
export type LockAcquisitionFailedDiagnostic = DiagnosticBase<
  'LOCK_ACQUISITION_FAILED',
  {
    readonly lockPath: string;
    readonly ownerPid: number;
  }
>;

/** Registry cache could not be read. */
export type CacheReadErrorDiagnostic = DiagnosticBase<
  'CACHE_READ_ERROR',
  {
    readonly cachePath: string;
    readonly reason: string;
  }
>;

/** Registry cache state is internally inconsistent or malformed. */
export type CacheCorruptDiagnostic = DiagnosticBase<
  'CACHE_CORRUPT',
  {
    readonly cachePath: string;
    readonly reason: string;
  }
>;

/** A shortened cache path belongs to a different full registry identifier. */
export type CacheIdentifierCollisionDiagnostic = DiagnosticBase<
  'CACHE_IDENTIFIER_COLLISION',
  {
    readonly cachePath: string;
    readonly expectedIdentifier: string;
    readonly actualIdentifier: string;
  }
>;

/** Registry could not be reached, optionally with cached state available. */
export type RegistryUnreachableDiagnostic = DiagnosticBase<
  'REGISTRY_UNREACHABLE',
  {
    readonly registryName: string;
    readonly url: string;
    readonly httpStatus?: number;
    readonly cause: string;
    readonly initialized: boolean;
  }
>;

/** Union of all registry diagnostics. */
export type RegistryDiagnostic =
  | NetworkErrorDiagnostic
  | GitErrorDiagnostic
  | SchemaInvalidDiagnostic
  | RegistryNotFoundDiagnostic
  | PackageRegistryAmbiguousDiagnostic
  | LockAcquisitionFailedDiagnostic
  | CacheReadErrorDiagnostic
  | CacheCorruptDiagnostic
  | CacheIdentifierCollisionDiagnostic
  | RegistryUnreachableDiagnostic;

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export function createNetworkErrorDiagnostic(url: string, reason: string): NetworkErrorDiagnostic {
  return {
    level: 'error',
    code: 'NETWORK_ERROR',
    message: `Network error for "${url}": ${reason}.`,
    hint: 'Check your network connection and retry.',
    data: { url, reason },
  };
}

export function createGitErrorDiagnostic(command: string, stderr: string, exitCode: number): GitErrorDiagnostic {
  return {
    level: 'error',
    code: 'GIT_ERROR',
    message: `Git command failed (exit ${exitCode}): ${command}.`,
    hint: 'Ensure git is installed and the registry URL is reachable.',
    data: { command, stderr, exitCode },
  };
}

export function createSchemaInvalidDiagnostic(filePath: string, issues: readonly string[]): SchemaInvalidDiagnostic {
  return {
    level: 'error',
    code: 'SCHEMA_INVALID',
    message: `Schema validation failed for "${filePath}".`,
    hint: 'Review the file against the expected schema.',
    data: { filePath, issues },
  };
}

export function createRegistryNotFoundDiagnostic(registryName: string): RegistryNotFoundDiagnostic {
  return {
    level: 'error',
    code: 'REGISTRY_NOT_FOUND',
    message: `Registry "${registryName}" is not defined in configuration.`,
    hint: `Add the registry. Example:
  uapkg registry add ${registryName} https://registry.example.com

Or configure manually:
  uapkg config set registries.${registryName}.url https://registry.example.com
  uapkg config set registries.${registryName}.ref.type branch
  uapkg config set registries.${registryName}.ref.value main`,
    data: { registryName },
  };
}

export function createPackageRegistryAmbiguousDiagnostic(
  packageName: string,
  registries: readonly string[],
): PackageRegistryAmbiguousDiagnostic {
  const declared = registries
    .slice(1)
    .map((alias) => JSON.stringify(alias))
    .join(', ');
  const flags = registries.map((alias) => {
    if (/^[A-Za-z0-9_.-]+$/.test(alias)) return `--registry ${alias}`;
    const quoted = process.platform === 'win32' ? alias.replaceAll("'", "''") : alias.replaceAll("'", "'\\''");
    return `--registry '${quoted}'`;
  });
  return {
    level: 'error',
    code: 'PACKAGE_REGISTRY_AMBIGUOUS',
    message: `Package "${packageName}" exists in the default registry. uapkg.json also lists it under ${declared}.`,
    hint: `Choose a registry and retry with ${flags.join(' or ')}.`,
    data: { packageName, registries },
  };
}

export function createLockAcquisitionFailedDiagnostic(
  lockPath: string,
  ownerPid: number,
): LockAcquisitionFailedDiagnostic {
  return {
    level: 'error',
    code: 'LOCK_ACQUISITION_FAILED',
    message: `Could not acquire registry lock at "${lockPath}" (held by PID ${ownerPid}).`,
    hint: 'Another uapkg process may be updating this registry. Wait or remove the stale lock.',
    data: { lockPath, ownerPid },
  };
}

export function createCacheReadErrorDiagnostic(cachePath: string, reason: string): CacheReadErrorDiagnostic {
  return {
    level: 'error',
    code: 'CACHE_READ_ERROR',
    message: `Failed to read registry cache at "${cachePath}": ${reason}.`,
    hint: 'The cache may be corrupted. Try running `uapkg update` to refresh.',
    data: { cachePath, reason },
  };
}

export function createCacheCorruptDiagnostic(cachePath: string, reason: string): CacheCorruptDiagnostic {
  return {
    level: 'error',
    code: 'CACHE_CORRUPT',
    message: `Registry cache at "${cachePath}" is corrupt: ${reason}.`,
    hint: 'Remove this registry cache directory and retry. Registry caches contain only disposable local data.',
    data: { cachePath, reason },
  };
}

export function createCacheIdentifierCollisionDiagnostic(
  cachePath: string,
  expectedIdentifier: string,
  actualIdentifier: string,
): CacheIdentifierCollisionDiagnostic {
  return {
    level: 'error',
    code: 'CACHE_IDENTIFIER_COLLISION',
    message: `Registry cache identifier collision at "${cachePath}".`,
    hint: 'Remove this registry cache directory and retry. If the collision recurs, report it to the uapkg maintainers.',
    data: { cachePath, expectedIdentifier, actualIdentifier },
  };
}

export function createRegistryUnreachableDiagnostic(input: {
  readonly registryName: string;
  readonly url: string;
  readonly cause: string;
  readonly initialized: boolean;
  readonly httpStatus?: number;
  readonly level?: 'error' | 'warning';
}): RegistryUnreachableDiagnostic {
  return {
    level: input.level ?? (input.initialized ? 'warning' : 'error'),
    code: 'REGISTRY_UNREACHABLE',
    message: `Git could not access the "${input.registryName}" registry at ${input.url}.`,
    emitPolicy: 'once',
    hint: `Confirm that the repository, network, and configured ref are available.
For a private registry, configure system Git credentials and run 'uapkg registry auth ${input.registryName}'.
Repository hosts may intentionally report an authorization failure as a missing repository.`,
    data: {
      registryName: input.registryName,
      url: input.url,
      cause: input.cause,
      initialized: input.initialized,
      httpStatus: input.httpStatus,
    },
  };
}
