import { ConfigInstance } from '@uapkg/config';
import { Installer } from '@uapkg/installer';
import { PackageManifest } from '@uapkg/package-manifest';
import { RegistryCore } from '@uapkg/registry-core';
import { AccountManager } from '#cli/control-plane/AccountManager.ts';
import { RegistryTrustResolver } from '#cli/control-plane/RegistryTrustResolver.ts';
import { WorkspaceLifecycle } from '#cli/lifecycle/WorkspaceLifecycle.ts';
import { DiagnosticReporter } from '#cli/reporting/DiagnosticReporter.ts';
import { JsonReporter } from '#cli/reporting/JsonReporter.ts';

export interface CompositionRootOptions {
  readonly cwd: string;
  readonly invocation?: readonly string[];
}

/**
 * Central dependency-injection root for the uapkg CLI.
 *
 * One instance is created per CLI invocation. It lazily constructs shared
 * services so commands that don't need them pay nothing. Every service this
 * root owns is either a pure facade (`PackageManifest`, `RegistryCore`) or a
 * stateless collaborator — there is no mutable shared state outside the
 * wrapped config/registry caches.
 *
 * Dependency graph (no cycles):
 *
 *   ConfigInstance ──► RegistryCore ──► PackageManifest
 *                     │                   │
 *                     └──► Installer ◄────┘
 *                          WorkspaceLifecycle
 *                          DiagnosticReporter / JsonReporter
 */
export class CompositionRoot {
  private _config?: InstanceType<typeof ConfigInstance>;
  private _registryCore?: RegistryCore;
  private _packageManifest?: PackageManifest;
  private _installer?: Installer;
  private _lifecycle?: WorkspaceLifecycle;
  private _diagnostics?: DiagnosticReporter;
  private _json?: JsonReporter;
  private _accountManager?: AccountManager;
  private _registryTrustResolver?: RegistryTrustResolver;

  public constructor(private readonly options: CompositionRootOptions) {}

  public get invocation(): readonly string[] | undefined {
    return this.options.invocation;
  }

  public get cwd(): string {
    return this.options.cwd;
  }

  public get config(): InstanceType<typeof ConfigInstance> {
    if (!this._config) {
      this._config = new ConfigInstance({ cwd: this.options.cwd });
    }
    return this._config;
  }

  public get registryCore(): RegistryCore {
    if (!this._registryCore) {
      // RegistryCore accepts a duck-typed config surface; ConfigInstance has
      // wider return types, so cast through `unknown` to satisfy the narrower
      // structural type.
      this._registryCore = new RegistryCore({
        configInstance: this.config as unknown as {
          get: (p?: string) => unknown;
          getAll: () => Record<string, unknown>;
          getDefaultRegistry: () => { url: string; ref: { type: string; value: string } } | null;
        },
      });
    }
    return this._registryCore;
  }

  public get packageManifest(): PackageManifest {
    if (!this._packageManifest) {
      this._packageManifest = new PackageManifest({
        manifestRoot: this.options.cwd,
        registryCore: this.registryCore,
        configInstance: this.config,
      });
    }
    return this._packageManifest;
  }

  public get installer(): Installer {
    if (!this._installer) {
      this._installer = new Installer({
        registryCore: this.registryCore,
        config: this.config,
      });
    }
    return this._installer;
  }

  public get lifecycle(): WorkspaceLifecycle {
    if (!this._lifecycle) {
      this._lifecycle = new WorkspaceLifecycle(this);
    }
    return this._lifecycle;
  }

  public get diagnostics(): DiagnosticReporter {
    if (!this._diagnostics) {
      this._diagnostics = new DiagnosticReporter();
    }
    return this._diagnostics;
  }

  public get json(): JsonReporter {
    if (!this._json) {
      this._json = new JsonReporter();
    }
    return this._json;
  }

  public get accountManager(): AccountManager {
    if (!this._accountManager) {
      this._accountManager = new AccountManager();
    }
    return this._accountManager;
  }

  public get registryTrustResolver(): RegistryTrustResolver {
    if (!this._registryTrustResolver) {
      this._registryTrustResolver = new RegistryTrustResolver(this);
    }
    return this._registryTrustResolver;
  }
}
