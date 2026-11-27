import { ConfigInstance } from '#config/core/ConfigInstance.ts';
import { createConfig } from '#config/factory/createConfig.ts';

const singleton = new ConfigInstance({ cwd: process.cwd() });

const Config = {
  get(pathToProperty?: string, options?: { scope?: 'global' | 'local' }) {
    return singleton.get(pathToProperty, options);
  },
  getAll(options?: { scope?: 'global' | 'local' }) {
    return singleton.getAll(options);
  },
  getDefaultRegistry() {
    return singleton.getDefaultRegistry();
  },
  getWithOrigin(pathToProperty: string) {
    return singleton.getWithOrigin(pathToProperty);
  },
  trace(pathToProperty: string) {
    return singleton.trace(pathToProperty);
  },
  getDiagnostics() {
    return singleton.getDiagnostics();
  },
  reload(options?: { cwd?: string }) {
    singleton.reload(options);
    return Config;
  },
};

export default Config;
export type {
  ConfigCreateOptions,
  ConfigTraceEntry,
  ConfigValueWithOrigin,
  LifecyclePolicyValue,
  RegistryConfig,
  RegistryRef,
  ResolvedConfig,
} from '#config/contracts/ConfigTypes.ts';
export { LifecyclePolicyResolver } from '#config/core/LifecyclePolicyResolver.ts';
export {
  getConfigSchemaAtPath,
  isLeafConfigPath,
  isValidConfigPath,
  validateConfigPath,
} from '#config/schema/pathSchema.ts';
export { parseConfigCliValue } from '#config/schema/runtime/ConfigSchemaRuntimeProvider.ts';
export { ConfigInstance, createConfig };
