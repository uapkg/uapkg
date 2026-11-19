import type { DiagnosticBase } from '#diagnostics/base/Diagnostic.ts';

// ---------------------------------------------------------------------------
// Manifest diagnostic codes
// ---------------------------------------------------------------------------

/** Manifest content failed schema validation. */
export type ManifestInvalidDiagnostic = DiagnosticBase<
  'MANIFEST_INVALID',
  {
    readonly filePath: string;
    readonly issues: readonly string[];
  }
>;

/** Lockfile content failed schema validation. */
export type LockfileInvalidDiagnostic = DiagnosticBase<
  'LOCKFILE_INVALID',
  {
    readonly filePath: string;
    readonly issues: readonly string[];
  }
>;

/** Lockfile is missing from disk. */
export type LockfileMissingDiagnostic = DiagnosticBase<
  'LOCKFILE_MISSING',
  {
    readonly filePath: string;
  }
>;

/** Lockfile is present but does not match manifest/config expectations. */
export type LockfileOutOfSyncDiagnostic = DiagnosticBase<
  'LOCKFILE_OUT_OF_SYNC',
  {
    readonly issues: readonly {
      readonly severity: 'error' | 'warning' | 'info';
      readonly code: string;
      readonly message: string;
      readonly packageName?: string;
    }[];
    readonly totalIssues: number;
    readonly additionalIssues: number;
    readonly logFilePath: string;
  }
>;

/** Overrides are only allowed in root project manifests. */
export type ForbiddenOverridesDiagnostic = DiagnosticBase<
  'FORBIDDEN_OVERRIDES',
  {
    readonly manifestKind: string;
    readonly filePath: string;
  }
>;

/** A registry name referenced in a dependency is not in configuration. */
export type UnresolvedRegistryDiagnostic = DiagnosticBase<
  'UNRESOLVED_REGISTRY',
  {
    readonly registryName: string;
    readonly dependencyName: string;
  }
>;

/** Failed to read a manifest or lockfile from disk. */
export type ManifestReadErrorDiagnostic = DiagnosticBase<
  'MANIFEST_READ_ERROR',
  {
    readonly filePath: string;
    readonly reason: string;
  }
>;

/** Failed to write a manifest or lockfile to disk. */
export type ManifestWriteErrorDiagnostic = DiagnosticBase<
  'MANIFEST_WRITE_ERROR',
  {
    readonly filePath: string;
    readonly reason: string;
  }
>;

/** The requested package is missing from the manifest's dependency declarations. */
export type DependencyNotFoundDiagnostic = DiagnosticBase<
  'DEPENDENCY_NOT_FOUND',
  {
    readonly packageName: string;
  }
>;

/** Union of all manifest diagnostics. */
export type ManifestDiagnostic =
  | ManifestInvalidDiagnostic
  | LockfileInvalidDiagnostic
  | LockfileMissingDiagnostic
  | LockfileOutOfSyncDiagnostic
  | ForbiddenOverridesDiagnostic
  | UnresolvedRegistryDiagnostic
  | ManifestReadErrorDiagnostic
  | ManifestWriteErrorDiagnostic
  | DependencyNotFoundDiagnostic;

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export function createManifestInvalidDiagnostic(
  filePath: string,
  issues: readonly string[],
): ManifestInvalidDiagnostic {
  return {
    level: 'error',
    code: 'MANIFEST_INVALID',
    message: `Manifest validation failed for "${filePath}".`,
    hint: 'Review your uapkg.json against the expected schema.',
    data: { filePath, issues },
  };
}

export function createLockfileInvalidDiagnostic(
  filePath: string,
  issues: readonly string[],
): LockfileInvalidDiagnostic {
  return {
    level: 'error',
    code: 'LOCKFILE_INVALID',
    message: `Lockfile validation failed for "${filePath}".`,
    hint: 'Delete uapkg.lock and re-run install to regenerate.',
    data: { filePath, issues },
  };
}

export function createLockfileMissingDiagnostic(
  filePath: string,
  level: 'warning' | 'error' = 'warning',
): LockfileMissingDiagnostic {
  return {
    level,
    code: 'LOCKFILE_MISSING',
    message: `No lockfile found at "${filePath}".`,
    hint: 'Run `uapkg install` to generate a lockfile, or use `--frozen` only when one already exists.',
    data: { filePath },
  };
}

export function createLockfileOutOfSyncDiagnostic(
  issues: readonly {
    readonly severity: 'error' | 'warning' | 'info';
    readonly code: string;
    readonly message: string;
    readonly packageName?: string;
  }[],
  totalIssues: number,
  logFilePath: string,
): LockfileOutOfSyncDiagnostic {
  return {
    level: 'error',
    code: 'LOCKFILE_OUT_OF_SYNC',
    message: 'Lockfile is out of sync with the current manifest and registry state.',
    hint: 'Run `uapkg install` or `uapkg update` to regenerate the lockfile before using `--frozen`.',
    data: {
      issues,
      totalIssues,
      additionalIssues: Math.max(0, totalIssues - issues.length),
      logFilePath,
    },
  };
}

export function createForbiddenOverridesDiagnostic(
  manifestKind: string,
  filePath: string,
): ForbiddenOverridesDiagnostic {
  return {
    level: 'error',
    code: 'FORBIDDEN_OVERRIDES',
    message: `Overrides are not allowed in "${manifestKind}" manifests ("${filePath}").`,
    hint: 'Overrides may only appear in root project manifests.',
    data: { manifestKind, filePath },
  };
}

export function createUnresolvedRegistryDiagnostic(
  registryName: string,
  dependencyName: string,
): UnresolvedRegistryDiagnostic {
  return {
    level: 'error',
    code: 'UNRESOLVED_REGISTRY',
    message: `Registry "${registryName}" referenced by dependency "${dependencyName}" is not configured.`,
    hint: 'Add the registry to your uapkg configuration.',
    data: { registryName, dependencyName },
  };
}

export function createManifestReadErrorDiagnostic(filePath: string, reason: string): ManifestReadErrorDiagnostic {
  return {
    level: 'error',
    code: 'MANIFEST_READ_ERROR',
    message: `Failed to read "${filePath}": ${reason}.`,
    hint: 'Ensure the file exists and is valid JSON.',
    data: { filePath, reason },
  };
}

export function createManifestWriteErrorDiagnostic(filePath: string, reason: string): ManifestWriteErrorDiagnostic {
  return {
    level: 'error',
    code: 'MANIFEST_WRITE_ERROR',
    message: `Failed to write "${filePath}": ${reason}.`,
    hint: 'Ensure the directory exists and you have write permissions.',
    data: { filePath, reason },
  };
}

export function createDependencyNotFoundDiagnostic(
  packageName: string,
  level: 'info' | 'error' = 'info',
): DependencyNotFoundDiagnostic {
  return {
    level,
    code: 'DEPENDENCY_NOT_FOUND',
    message: `Package "${packageName}" is not declared as a dependency in uapkg.json.`,
    hint: 'Run `uapkg list` to inspect currently declared dependencies.',
    data: { packageName },
  };
}
