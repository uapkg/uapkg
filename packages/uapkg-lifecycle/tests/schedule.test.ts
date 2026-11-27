import { describe, expect, it } from 'vite-plus/test';
import { orderedReleases, releaseCapabilities, sameRelease } from '../src/index.ts';

describe('lifecycle scheduling and grants', () => {
  it('visits a diamond dependency once before its consumers, regardless of resolver order', () => {
    const graph = [
      { packageName: 'a', dependencies: ['c', 'b'] },
      { packageName: 'c', dependencies: ['shared'] },
      { packageName: 'independent', dependencies: [] },
      { packageName: 'shared', dependencies: [] },
      { packageName: 'b', dependencies: ['shared'] },
    ];
    const names = (nodes: typeof graph) => orderedReleases(nodes).map((node) => node.packageName);
    expect(names(graph)).toEqual(['shared', 'b', 'c', 'a', 'independent']);
    expect(names([...graph].reverse())).toEqual(names(graph));
  });

  it('matches the registry source, exact release and explicit capability', () => {
    const release = {
      registry: 'default',
      registryId: 'source A',
      packageName: '@owner/tool',
      version: '1.2.0',
      integrity: 'digest A',
    };
    const grants = [{ ...release, capabilities: ['integration'] as const }];
    expect(releaseCapabilities(grants, release)).toEqual(['integration']);
    expect(releaseCapabilities(undefined, release)).toBeUndefined();
    expect(releaseCapabilities(grants, { ...release, registry: 'other-alias' })).toEqual(['integration']);
    for (const change of [
      { registryId: 'source B' },
      { packageName: '@other/tool' },
      { version: '1.2.1' },
      { integrity: 'digest B' },
    ]) {
      expect(sameRelease(release, { ...release, ...change })).toBe(false);
      expect(releaseCapabilities(grants, { ...release, ...change })).toBeUndefined();
    }
  });
});
