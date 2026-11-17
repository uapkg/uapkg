import { DiagnosticBag } from '@uapkg/diagnostics';
import type { ConfigLayer, ConfigLayerBuildResult } from '#config/contracts/ConfigTypes.ts';
import { ConfigFileRepository } from '#config/files/ConfigFileRepository.ts';
import { ConfigPathResolver } from '#config/files/ConfigPathResolver.ts';
import { getDefaultConfig, launcherUpdateKeys } from '#config/schema/configSchema.ts';
import { isRecordValue } from '#config/schema/runtime/ConfigSchemaIntrospection.ts';

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
        values: this.readValues(paths.globalFile, bag),
      },
    ];

    for (const intermediaryFile of paths.intermediaryFiles) {
      layers.push({
        source: 'intermediary',
        file: intermediaryFile,
        values: this.readProjectValues(intermediaryFile, bag),
      });
    }

    layers.push({
      source: 'local',
      file: paths.localFile,
      values: this.readProjectValues(paths.localFile, bag),
    });

    return { layers, diagnostics: bag.all() };
  }

  private readValues(filePath: string, bag: DiagnosticBag): Record<string, unknown> {
    const result = this.repository.read(filePath);
    if (!result.ok) {
      bag.mergeArray(result.diagnostics);
      return {};
    }
    bag.mergeArray(result.value.diagnostics);
    return result.value.values;
  }

  private readProjectValues(filePath: string, bag: DiagnosticBag): Record<string, unknown> {
    const values = this.readValues(filePath, bag);
    if (!isRecordValue(values.launcher)) return values;

    const launcher = { ...values.launcher };
    for (const key of launcherUpdateKeys) delete launcher[key];
    return { ...values, launcher };
  }
}
