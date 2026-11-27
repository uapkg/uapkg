import type { LifecyclePolicyValue, ResolvedConfig } from '#config/contracts/ConfigTypes.ts';

export class LifecyclePolicyResolver {
  public resolve(config: ResolvedConfig, registryName: string): LifecyclePolicyValue {
    return config.registries[registryName]?.lifecyclePolicy ?? config.install.lifecyclePolicy;
  }
}
