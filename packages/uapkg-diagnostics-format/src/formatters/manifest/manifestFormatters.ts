import type {
  DependencyNotFoundDiagnostic,
  Diagnostic,
  ForbiddenOverridesDiagnostic,
  LockfileMissingDiagnostic,
  LockfileOutOfSyncDiagnostic,
  ManifestInvalidDiagnostic,
} from '@uapkg/diagnostics';
import type { FormatterMap } from '#diagnostics-format/contracts/FormatterTypes.ts';

function formatManifestInvalid(d: Diagnostic): string {
  const data = (d as ManifestInvalidDiagnostic).data;
  const lines = [`[ERROR MANIFEST_INVALID]: ${d.message}`, `  File: ${data.filePath}`];
  for (const issue of data.issues) {
    lines.push(`    - ${issue}`);
  }
  if (d.hint) lines.push(`  → ${d.hint}`);
  return lines.join('\n');
}

function formatForbiddenOverrides(d: Diagnostic): string {
  const data = (d as ForbiddenOverridesDiagnostic).data;
  const lines = [
    `[ERROR FORBIDDEN_OVERRIDES]: ${d.message}`,
    `  Kind: ${data.manifestKind}`,
    `  File: ${data.filePath}`,
  ];
  if (d.hint) lines.push(`  → ${d.hint}`);
  return lines.join('\n');
}

function formatLockfileMissing(d: Diagnostic): string {
  const data = (d as LockfileMissingDiagnostic).data;
  const lines = [`[${d.level.toUpperCase()} LOCKFILE_MISSING]: ${d.message}`, `  File: ${data.filePath}`];
  if (d.hint) lines.push(`  → ${d.hint}`);
  return lines.join('\n');
}

function formatDependencyNotFound(d: Diagnostic): string {
  const data = (d as DependencyNotFoundDiagnostic).data;
  const lines = [`[${d.level.toUpperCase()} DEPENDENCY_NOT_FOUND]: ${d.message}`, `  Package: ${data.packageName}`];
  if (d.hint) lines.push(`  → ${d.hint}`);
  return lines.join('\n');
}

function formatLockfileOutOfSync(d: Diagnostic): string {
  const data = (d as LockfileOutOfSyncDiagnostic).data;
  const lines = ['[ERROR LOCKFILE_OUT_OF_SYNC]: Lockfile is out of sync with the following errors:'];
  data.issues.forEach((issue, index) => {
    lines.push(`  ${index + 1}. [${issue.severity.toUpperCase()} ${issue.code}] ${issue.message}`);
  });
  if (data.additionalIssues > 0) {
    lines.push(`  There are ${data.additionalIssues} additional errors.`);
  }
  lines.push(`  View the full error list at: ${data.logFilePath}`);
  if (d.hint) lines.push(`  → ${d.hint}`);
  return lines.join('\n');
}

export const manifestFormatters: FormatterMap = {
  MANIFEST_INVALID: formatManifestInvalid,
  FORBIDDEN_OVERRIDES: formatForbiddenOverrides,
  LOCKFILE_MISSING: formatLockfileMissing,
  DEPENDENCY_NOT_FOUND: formatDependencyNotFound,
  LOCKFILE_OUT_OF_SYNC: formatLockfileOutOfSync,
};
