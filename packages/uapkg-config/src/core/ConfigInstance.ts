import type { Diagnostic, Result } from '@uapkg/diagnostics';
import type {
  ConfigCreateOptions,
  ConfigGetOptions,
  ConfigLayer,
  ConfigListOptions,
  ConfigReloadOptions,
  ConfigTraceEntry,
  ConfigValueWithOrigin,
  ConfigWriteOptions,
  ResolvedConfig,
} from '#config/contracts/ConfigTypes.ts';
import { validateConfigPath } from '#config/schema/pathSchema.ts';
import { ConfigLayerBuilder } from '#config/core/ConfigLayerBuilder.ts';
import { ConfigResolver } from '#config/core/ConfigResolver.ts';
import { ConfigWriter } from '#config/core/ConfigWriter.ts';

export class ConfigInstance {
  private cwd: string;
  private layers: ConfigLayer[] = [];
  private resolved: Record<string, unknown> = {};
  private diagnostics: readonly Diagnostic[] = [];

  constructor(
    options: ConfigCreateOptions = {},
    private readonly layerBuilder = new ConfigLayerBuilder(),
    private readonly resolver = new ConfigResolver(),
    private readonly writer = new ConfigWriter(),
  ) {
    this.cwd = options.cwd ?? process.cwd();
    this.reload({ cwd: this.cwd });
  }

  get(pathToProperty?: string, options: ConfigGetOptions = {}) {
    if (options.scope) {
      if (!pathToProperty) {
        const rawResult = this.writer.getRaw(this.cwd, options);
        if (!rawResult.ok) return null;
        return rawResult.value;
      }

      const pathResult = validateConfigPath(pathToProperty);
      if (!pathResult.ok) return null;

      const scopedResult = this.writer.getRaw(this.cwd, options);
      if (!scopedResult.ok) return null;
      if (scopedResult.value === null) return null;

      return this.getValueFromObject(scopedResult.value, pathToProperty);
    }

    if (!pathToProperty) {
      return this.getAll();
    }

    const pathResult = validateConfigPath(pathToProperty);
    if (!pathResult.ok) return null;

    return this.getValueFromObject(this.resolved, pathToProperty);
  }

  getAll(): ResolvedConfig;
  getAll(options?: ConfigListOptions): ResolvedConfig | Record<string, unknown> | null;
  getAll(options: ConfigListOptions = {}): ResolvedConfig | Record<string, unknown> | null {
    if (options.scope) {
      const result = this.writer.listRaw(this.cwd, options);
      if (!result.ok) return null;
      return result.value;
    }

    return this.resolved;
  }

  getDefaultRegistry() {
    const selected = this.get('registry');
    const registries = this.get('registries');
    if (typeof selected !== 'string') return null;
    if (typeof registries !== 'object' || registries === null || Array.isArray(registries)) return null;

    const candidate = (registries as Record<string, unknown>)[selected];
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return null;

    const url = (candidate as Record<string, unknown>).url;
    const ref = (candidate as Record<string, unknown>).ref;
    if (typeof url !== 'string') return null;
    if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) return null;

    const type = (ref as Record<string, unknown>).type;
    const value = (ref as Record<string, unknown>).value;
    if (typeof type !== 'string' || typeof value !== 'string') return null;

    return { url, ref: { type, value } };
  }

  getWithOrigin(pathToProperty: string): ConfigValueWithOrigin | null {
    const pathResult = validateConfigPath(pathToProperty);
    if (!pathResult.ok) return null;
    return this.resolver.getWithOrigin(this.layers, pathToProperty);
  }

  trace(pathToProperty: string): ConfigTraceEntry[] {
    const pathResult = validateConfigPath(pathToProperty);
    if (!pathResult.ok) return [];
    return this.resolver.trace(this.layers, pathToProperty);
  }

  set(
    pathToProperty: string,
    value: unknown,
    options: ConfigWriteOptions = {},
  ): Result<{ file: string; values: Record<string, unknown> }> {
    return this.writer.prepareSet(this.cwd, pathToProperty, value, options);
  }

  delete(
    pathToProperty: string,
    options: ConfigWriteOptions = {},
  ): Result<{ file: string; values: Record<string, unknown> }> {
    return this.writer.prepareDelete(this.cwd, pathToProperty, options);
  }

  getEditTarget(options: ConfigWriteOptions = {}) {
    return this.writer.getEditTarget(this.cwd, options.scope);
  }

  toDisplayPath(filePath: string) {
    return this.writer.toDisplayPath(this.cwd, filePath);
  }

  getDiagnostics(): readonly Diagnostic[] {
    return this.diagnostics;
  }

  reload(options: ConfigReloadOptions = {}) {
    this.cwd = options.cwd ?? this.cwd;
    const buildResult = this.layerBuilder.build(this.cwd);
    this.layers = buildResult.layers;

    const resolvedResult = this.resolver.resolveAll(this.layers);
    this.resolved = resolvedResult.value;
    this.diagnostics = [...buildResult.diagnostics, ...resolvedResult.diagnostics];
    return this;
  }

  private getValueFromObject(data: unknown, pathToProperty: string) {
    const segments = pathToProperty.split('.');
    let current = data;

    for (const segment of segments) {
      if (typeof current !== 'object' || current === null || Array.isArray(current) || !(segment in current)) {
        return null;
      }

      current = (current as Record<string, unknown>)[segment];
    }

    return current;
  }
}
