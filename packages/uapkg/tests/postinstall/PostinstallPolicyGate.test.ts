import type { ResolvedConfig } from '@uapkg/config';
import { describe, expect, it } from 'vite-plus/test';
import { PostinstallPolicyGate } from '../../src/postinstall/policy/PostinstallPolicyGate.ts';

function makeConfig(partial: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    launcher: { cliSource: 'github-releases' },
    registry: '',
    registries: {},
    git: 'git',
    editor: '',
    exec: { shell: '' },
    cache: { enabled: true },
    registryCache: { ttlSeconds: 0 },
    network: { retries: 0, timeout: 0, maxConcurrentDownloads: 1 },
    install: { postInstallPolicy: 'deny' },
    term: { quiet: false, verbose: false },
    ...partial,
  };
}

describe('PostinstallPolicyGate', () => {
  it('denies by default (global policy = deny)', () => {
    const reader = { getAll: (): ResolvedConfig => makeConfig() };
    const gate = new PostinstallPolicyGate(reader);
    const decision = gate.evaluate('pkg', 'registry1');
    expect(decision.allowed).toBe(false);
    expect(decision.policy).toBe('deny');
    expect(decision.denialDiagnostic?.code).toBe('POSTINSTALL_POLICY_DENIED');
  });

  it('allows when global policy = allow', () => {
    const reader = {
      getAll: (): ResolvedConfig => makeConfig({ install: { postInstallPolicy: 'allow' } }),
    };
    const gate = new PostinstallPolicyGate(reader);
    const decision = gate.evaluate('pkg', 'registry1');
    expect(decision.allowed).toBe(true);
    expect(decision.policy).toBe('allow');
    expect(decision.denialDiagnostic).toBeUndefined();
  });

  it('per-registry override beats global deny', () => {
    const reader = {
      getAll: (): ResolvedConfig =>
        makeConfig({
          install: { postInstallPolicy: 'deny' },
          registries: {
            trusted: {
              url: 'https://example.com',
              ref: { type: 'branch', value: 'main' },
              postInstallPolicy: 'allow',
            },
          },
        }),
    };
    const gate = new PostinstallPolicyGate(reader);
    const decision = gate.evaluate('pkg', 'trusted');
    expect(decision.allowed).toBe(true);
    expect(decision.resolvedFrom).toBe('registry');
  });

  it('falls back to deny on malformed config', () => {
    const reader = { getAll: () => null };
    const gate = new PostinstallPolicyGate(reader);
    const decision = gate.evaluate('pkg', 'r');
    expect(decision.allowed).toBe(false);
  });
});
