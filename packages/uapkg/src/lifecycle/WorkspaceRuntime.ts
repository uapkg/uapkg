import { NodeVersionManager } from '@uapkg/node-version-manager';
import type { Lockfile } from '@uapkg/package-manifest-schema';
import type { CompositionRoot } from '#cli/app/CompositionRoot.ts';

/** Pin selection is separate from provisioning: granting permission never starts package code. */
export class WorkspaceRuntime {
  private readonly manager = new NodeVersionManager();
  private readonly offline = process.env.UAPKG_OFFLINE === '1';
  private readonly resolved = new Map<string, string>();
  constructor(
    private readonly root: CompositionRoot,
    private readonly options: { frozen?: boolean; refresh?: boolean } = {},
  ) {}

  async pin(selector: string): Promise<string> {
    const resolved = this.resolved.get(selector);
    if (resolved) return resolved;
    const read = await this.root.packageManifest.readLockfileOptional();
    if (!read.ok) throw new Error(read.diagnostics.map((d) => d.message).join('\n'));
    const lock: Lockfile = read.value ?? { lockfileVersion: 1, packages: {} };
    const pins = lock.lifecycleRuntimes?.node ?? {};
    const version = await this.manager.resolveVersion(selector, { pins, offline: this.offline, ...this.options });
    if (!this.options.frozen && pins[selector] !== version) {
      const write = await this.root.packageManifest.writeLockfile({
        ...lock,
        lifecycleRuntimes: { node: { ...pins, [selector]: version } },
      });
      if (!write.ok) throw new Error(write.diagnostics.map((d) => d.message).join('\n'));
    }
    this.resolved.set(selector, version);
    return version;
  }

  async executable(selector: string): Promise<string> {
    return this.manager.ensureRuntime(await this.pin(selector), { offline: this.offline });
  }
}
