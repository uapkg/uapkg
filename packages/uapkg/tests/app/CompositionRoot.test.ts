import { describe, expect, it } from 'vite-plus/test';
import { CompositionRoot } from '../../src/app/CompositionRoot.ts';

describe('CompositionRoot', () => {
  it('cwd is returned as provided', () => {
    const root = new CompositionRoot({ cwd: 'D:\\tmp\\project' });
    expect(root.cwd).toBe('D:\\tmp\\project');
  });

  it('config getter is lazy and memoized', () => {
    const root = new CompositionRoot({ cwd: process.cwd() });
    const a = root.config;
    const b = root.config;
    expect(a).toBe(b);
  });

  it('registryCore getter is memoized', () => {
    const root = new CompositionRoot({ cwd: process.cwd() });
    expect(root.registryCore).toBe(root.registryCore);
  });

  it('packageManifest getter is memoized', () => {
    const root = new CompositionRoot({ cwd: process.cwd() });
    expect(root.packageManifest).toBe(root.packageManifest);
  });

  it('installer getter is memoized', () => {
    const root = new CompositionRoot({ cwd: process.cwd() });
    expect(root.installer).toBe(root.installer);
  });

  it('lifecycle getter is memoized', () => {
    const root = new CompositionRoot({ cwd: process.cwd() });
    expect(root.lifecycle).toBe(root.lifecycle);
  });

  it('diagnostics and json reporters are memoized', () => {
    const root = new CompositionRoot({ cwd: process.cwd() });
    expect(root.diagnostics).toBe(root.diagnostics);
    expect(root.json).toBe(root.json);
  });
});
