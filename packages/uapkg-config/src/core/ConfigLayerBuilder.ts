import { DiagnosticBag } from '@uapkg/diagnostics';
import type { ConfigLayer, ConfigLayerBuildResult } from '#config/contracts/ConfigTypes.ts';
import { ConfigFileRepository } from '#config/files/ConfigFileRepository.ts';
import { ConfigPathResolver } from '#config/files/ConfigPathResolver.ts';
import { getDefaultConfig } from '#config/schema/configSchema.ts';

export class ConfigLayerBuilder {
  constructor(
    private readonly pathResolver = new ConfigPathResolver(),
    private readonly repository = new ConfigFileRepository(),
  ) {}

  build(cwd: string): ConfigLayerBuildResult {
    const paths = this.pathResolver.resolve(cwd);
    const bag = new DiagnosticBag();

    const layers: ConfigLayer[] = [
      {
        source: 'default',
        values: getDefaultConfig() as unknown as Record<string, unknown>,
      },
      {
        source: 'global',
        file: paths.globalFile,
        ...this.readLayer(paths.globalFile, bag),
      },
    ];

    for (const intermediaryFile of paths.intermediaryFiles) {
      layers.push({
        source: 'intermediary',
        file: intermediaryFile,
        ...this.readLayer(intermediaryFile, bag),
      });
    }

    layers.push({
      source: 'local',
      file: paths.localFile,
      ...this.readLayer(paths.localFile, bag),
    });

    return { layers, diagnostics: bag.all() };
  }

  private readLayer(filePath: string, bag: DiagnosticBag): Pick<ConfigLayer, 'values' | 'ignoredReason'> {
    const result = this.repository.read(filePath);
    if (!result.ok) {
      bag.mergeArray(result.diagnostics);
      return { values: {}, ignoredReason: result.diagnostics[0]?.message ?? 'The config file could not be read' };
    }
    bag.mergeArray(result.value.diagnostics);
    return {
      values: result.value.values,
      ...(result.value.diagnostics.length ? { ignoredReason: result.value.diagnostics[0]?.message } : {}),
    };
  }
}
