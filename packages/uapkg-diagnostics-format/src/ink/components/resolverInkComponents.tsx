import type {
  CircularDepDiagnostic,
  PackageNotFoundDiagnostic,
  RegistryNameCollisionDiagnostic,
  VersionConflictDiagnostic,
  VersionNotFoundDiagnostic,
} from '@uapkg/diagnostics';
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { DiagnosticBodyProps, DiagnosticInkComponentMap } from '#diagnostics-format/ink/contracts/InkTypes.ts';

function VersionConflict({ diagnostic }: DiagnosticBodyProps): ReactElement {
  const data = (diagnostic as VersionConflictDiagnostic).data;
  return (
    <Box flexDirection="column">
      <Text>
        Package <Text color="cyan">{data.packageName}</Text> in registry <Text color="cyan">{data.registry}</Text>{' '}
        resolved to conflicting versions:
      </Text>
      {data.versions.map((v) => (
        <Text key={v}>
          {' '}
          • <Text color="yellow">{v}</Text>
        </Text>
      ))}
    </Box>
  );
}

function CircularDep({ diagnostic }: DiagnosticBodyProps): ReactElement {
  const data = (diagnostic as CircularDepDiagnostic).data;
  return (
    <Text>
      Cycle: <Text color="yellow">{data.path.join(' → ')}</Text>
    </Text>
  );
}

function PackageNotFound({ diagnostic }: DiagnosticBodyProps): ReactElement {
  const data = (diagnostic as PackageNotFoundDiagnostic).data;
  if (!data.registry) return <Text>{diagnostic.message}</Text>;
  return (
    <Text>
      Could not find <Text color="cyan">{data.packageName}</Text> in registry <Text color="cyan">{data.registry}</Text>.
    </Text>
  );
}

function VersionNotFound({ diagnostic }: DiagnosticBodyProps): ReactElement {
  const data = (diagnostic as VersionNotFoundDiagnostic).data;
  return (
    <Box flexDirection="column">
      <Text>
        No version of <Text color="cyan">{data.packageName}</Text> matches{' '}
        <Text color="yellow">{data.versionRange}</Text> (registry <Text color="cyan">{data.registry}</Text>).
      </Text>
      {data.availableVersions.length > 0 ? (
        <Text>Available: {data.availableVersions.join(', ')}</Text>
      ) : (
        <Text color="gray">No versions are published yet.</Text>
      )}
    </Box>
  );
}

function RegistryNameCollision({ diagnostic }: DiagnosticBodyProps): ReactElement {
  const data = (diagnostic as RegistryNameCollisionDiagnostic).data;
  return (
    <Text>
      <Text color="cyan">{data.packageName}</Text> is required from multiple registries:{' '}
      <Text color="yellow">{data.registries.join(', ')}</Text>.
    </Text>
  );
}

export const resolverInkComponents: DiagnosticInkComponentMap = {
  VERSION_CONFLICT: VersionConflict,
  CIRCULAR_DEP: CircularDep,
  PACKAGE_NOT_FOUND: PackageNotFound,
  VERSION_NOT_FOUND: VersionNotFound,
  REGISTRY_NAME_COLLISION: RegistryNameCollision,
};
