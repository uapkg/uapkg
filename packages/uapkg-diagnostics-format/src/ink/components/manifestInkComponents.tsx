import type {
  DependencyNotFoundDiagnostic,
  ForbiddenOverridesDiagnostic,
  LockfileInvalidDiagnostic,
  LockfileMissingDiagnostic,
  LockfileOutOfSyncDiagnostic,
  ManifestInvalidDiagnostic,
  ManifestReadErrorDiagnostic,
  ManifestWriteErrorDiagnostic,
  UnresolvedRegistryDiagnostic,
} from '@uapkg/diagnostics';
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { DiagnosticBodyProps, DiagnosticInkComponentMap } from '#diagnostics-format/ink/contracts/InkTypes.ts';

function buildLockfileIssueKey(issue: {
  readonly severity: string;
  readonly code: string;
  readonly message: string;
  readonly packageName?: string;
}): string {
  return `${issue.severity}:${issue.code}:${issue.packageName ?? ''}:${issue.message}`;
}

function FileIssues({
  filePath,
  issues,
}: {
  readonly filePath: string;
  readonly issues: readonly string[];
}): ReactElement {
  return (
    <Box flexDirection="column">
      <Text>
        File: <Text color="cyan">{filePath}</Text>
      </Text>
      {issues.map((issue) => (
        <Text key={issue}> • {issue}</Text>
      ))}
    </Box>
  );
}

function ManifestInvalid({ diagnostic }: DiagnosticBodyProps): ReactElement {
  const data = (diagnostic as ManifestInvalidDiagnostic).data;
  return <FileIssues filePath={data.filePath} issues={data.issues} />;
}

function LockfileInvalid({ diagnostic }: DiagnosticBodyProps): ReactElement {
  const data = (diagnostic as LockfileInvalidDiagnostic).data;
  return <FileIssues filePath={data.filePath} issues={data.issues} />;
}

function ForbiddenOverrides({ diagnostic }: DiagnosticBodyProps): ReactElement {
  const data = (diagnostic as ForbiddenOverridesDiagnostic).data;
  return (
    <Text>
      <Text color="cyan">{data.manifestKind}</Text> manifest at <Text color="cyan">{data.filePath}</Text> cannot declare
      overrides.
    </Text>
  );
}

function UnresolvedRegistry({ diagnostic }: DiagnosticBodyProps): ReactElement {
  const data = (diagnostic as UnresolvedRegistryDiagnostic).data;
  return (
    <Text>
      Dependency <Text color="cyan">{data.dependencyName}</Text> references registry{' '}
      <Text color="yellow">{data.registryName}</Text>, but no such registry is configured.
    </Text>
  );
}

function ManifestReadError({ diagnostic }: DiagnosticBodyProps): ReactElement {
  const data = (diagnostic as ManifestReadErrorDiagnostic).data;
  return (
    <Box flexDirection="column">
      <Text>
        Could not read <Text color="cyan">{data.filePath}</Text>.
      </Text>
      <Text color="gray">{data.reason}</Text>
    </Box>
  );
}

function ManifestWriteError({ diagnostic }: DiagnosticBodyProps): ReactElement {
  const data = (diagnostic as ManifestWriteErrorDiagnostic).data;
  return (
    <Box flexDirection="column">
      <Text>
        Could not write <Text color="cyan">{data.filePath}</Text>.
      </Text>
      <Text color="gray">{data.reason}</Text>
    </Box>
  );
}

function LockfileMissing({ diagnostic }: DiagnosticBodyProps): ReactElement {
  const data = (diagnostic as LockfileMissingDiagnostic).data;
  return (
    <Text>
      Lockfile not found at <Text color="cyan">{data.filePath}</Text>.
    </Text>
  );
}

function DependencyNotFound({ diagnostic }: DiagnosticBodyProps): ReactElement {
  const data = (diagnostic as DependencyNotFoundDiagnostic).data;
  return (
    <Text>
      Package <Text color="cyan">{data.packageName}</Text> is not declared as a dependency in uapkg.json.
    </Text>
  );
}

function LockfileOutOfSync({ diagnostic }: DiagnosticBodyProps): ReactElement {
  const data = (diagnostic as LockfileOutOfSyncDiagnostic).data;
  return (
    <Box flexDirection="column">
      <Text>Lockfile is out of sync with the following errors:</Text>
      {data.issues.map((issue, index) => (
        <Text key={buildLockfileIssueKey(issue)}>
          {' '}
          {index + 1}. [{issue.severity.toUpperCase()} {issue.code}] {issue.message}
        </Text>
      ))}
      {data.additionalIssues > 0 ? <Text>There are {data.additionalIssues} additional errors.</Text> : null}
      <Text>
        View full list at: <Text color="cyan">{data.logFilePath}</Text>
      </Text>
    </Box>
  );
}

export const manifestInkComponents: DiagnosticInkComponentMap = {
  MANIFEST_INVALID: ManifestInvalid,
  LOCKFILE_INVALID: LockfileInvalid,
  LOCKFILE_MISSING: LockfileMissing,
  LOCKFILE_OUT_OF_SYNC: LockfileOutOfSync,
  FORBIDDEN_OVERRIDES: ForbiddenOverrides,
  UNRESOLVED_REGISTRY: UnresolvedRegistry,
  MANIFEST_READ_ERROR: ManifestReadError,
  MANIFEST_WRITE_ERROR: ManifestWriteError,
  DEPENDENCY_NOT_FOUND: DependencyNotFound,
};
