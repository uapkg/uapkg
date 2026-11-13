import Config, {
  type ConfigInstance,
  PostInstallPolicyResolver,
  type PostInstallPolicyValue,
  type ResolvedConfig,
} from '@uapkg/config';
import { createPostinstallPolicyDeniedDiagnostic, type PostinstallPolicyDeniedDiagnostic } from '@uapkg/diagnostics';

/** Minimal config reader surface; defaults to the singleton `@uapkg/config`. */
export interface PolicyConfigReader {
  getAll(): ResolvedConfig | Record<string, unknown> | null;
}

export interface PolicyDecision {
  /** Whether the policy allows running a plugin's postinstall. */
  readonly allowed: boolean;
  /** The effective policy value ("allow"/"deny"). */
  readonly policy: PostInstallPolicyValue;
  /** Where the value was read from. */
  readonly resolvedFrom: 'registry' | 'install';
  /**
   * Populated only when `allowed === false`. Callers attach this to their
   * diagnostic bag and continue with other plugins (skipping is non-fatal).
   */
  readonly denialDiagnostic?: PostinstallPolicyDeniedDiagnostic;
}

/**
 * Consults {@link PostInstallPolicyResolver} to decide whether a given plugin's
 * postinstall script should run. The resolver honors per-registry overrides
 * and falls back to the global `install.postInstallPolicy` default (`deny`).
 *
 * This class is a thin glue layer so the orchestrator stays free of config
 * vocabulary.
 */
export class PostinstallPolicyGate {
  public constructor(
    private readonly reader: PolicyConfigReader = Config as unknown as PolicyConfigReader,
    private readonly resolver: PostInstallPolicyResolver = new PostInstallPolicyResolver(),
  ) {}

  public evaluate(packageName: string, registryName: string): PolicyDecision {
    const resolved = this.readResolved();
    const { policy, resolvedFrom } = this.resolver.resolve(resolved, registryName);
    if (policy === 'allow') {
      return { allowed: true, policy, resolvedFrom };
    }
    return {
      allowed: false,
      policy,
      resolvedFrom,
      denialDiagnostic: createPostinstallPolicyDeniedDiagnostic(packageName, registryName, policy, resolvedFrom),
    };
  }

  private readResolved(): ResolvedConfig {
    const value = this.reader.getAll();
    if (!value || typeof value !== 'object' || !('install' in value)) {
      // Defensive: if the caller passed an unresolved config, fall back to deny.
      return FALLBACK_RESOLVED_CONFIG;
    }
    return value as ResolvedConfig;
  }
}

/**
 * Construct-or-else fallback: never used with the real `@uapkg/config`
 * singleton (which always produces a `ResolvedConfig`), but shields the gate
 * from arbitrary callers that might pass a partial config.
 */
const FALLBACK_RESOLVED_CONFIG: ResolvedConfig = {
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
};

export type { ConfigInstance };
