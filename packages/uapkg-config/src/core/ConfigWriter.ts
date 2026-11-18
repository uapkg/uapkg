import path from 'node:path';
import {
  createConfigInvalidValueDiagnostic,
  createParseErrorDiagnostic,
  DiagnosticBag,
  fail,
  ok,
  type Result,
} from '@uapkg/diagnostics';
import type {
  ConfigGetOptions,
  ConfigListOptions,
  ConfigScope,
  ConfigWriteOptions,
} from '#config/contracts/ConfigTypes.ts';
import { ConfigFileRepository } from '#config/files/ConfigFileRepository.ts';
import { ConfigPathResolver } from '#config/files/ConfigPathResolver.ts';
import { partialConfigSchema } from '#config/schema/configSchema.ts';
import { deleteValueByPath, setValueByPath, validateConfigPath } from '#config/schema/pathSchema.ts';

export class ConfigWriter {
  constructor(
    private readonly pathResolver = new ConfigPathResolver(),
    private readonly repository = new ConfigFileRepository(),
  ) {}

  getRaw(cwd: string, options: ConfigGetOptions = {}): Result<Record<string, unknown> | null> {
    if (options.scope === 'global') {
      const globalPath = this.pathResolver.resolve(cwd).globalFile;
      const readResult = this.repository.read(globalPath);
      if (!readResult.ok) return readResult as Result<never>;
      return ok(readResult.value.values);
    }

    if (options.scope === 'local') {
      const localPath = this.pathResolver.findNearestLocalConfig(cwd);
      if (!localPath) {
        return ok(null);
      }

      const readResult = this.repository.read(localPath);
      if (!readResult.ok) return readResult as Result<never>;
      return ok(readResult.value.values);
    }

    return fail([createParseErrorDiagnostic('Scope is required for getRaw')]);
  }

  listRaw(cwd: string, options: ConfigListOptions = {}): Result<Record<string, unknown> | null> {
    return this.getRaw(cwd, { scope: options.scope });
  }

  prepareSet(
    cwd: string,
    pathToProperty: string,
    value: unknown,
    options: ConfigWriteOptions = {},
  ): Result<{ file: string; values: Record<string, unknown> }> {
    const bag = new DiagnosticBag();

    const pathResult = validateConfigPath(pathToProperty);
    if (!pathResult.ok) {
      bag.mergeArray(pathResult.diagnostics);
      return bag.toFailure();
    }

    if (value === null) {
      bag.addError('PARSE_ERROR', 'null is not a valid config value', { reason: 'null is not a valid config value' });
      return bag.toFailure();
    }

    const targetFile = this.getEditTarget(cwd, options.scope);
    const readResult = this.repository.read(targetFile);
    if (!readResult.ok) {
      bag.mergeArray(readResult.diagnostics);
      return bag.toFailure();
    }

    const cloned = structuredClone(readResult.value.values);
    setValueByPath(cloned, pathToProperty, value);

    const validation = partialConfigSchema.safeParse(cloned);
    if (!validation.success) {
      for (const issue of validation.error.issues) {
        bag.add(createConfigInvalidValueDiagnostic(issue.path.join('.'), issue.message));
      }
      return bag.toFailure();
    }

    return ok({ file: targetFile, values: cloned });
  }

  prepareDelete(
    cwd: string,
    pathToProperty: string,
    options: ConfigWriteOptions = {},
  ): Result<{ file: string; values: Record<string, unknown> }> {
    const bag = new DiagnosticBag();

    const pathResult = validateConfigPath(pathToProperty);
    if (!pathResult.ok) {
      bag.mergeArray(pathResult.diagnostics);
      return bag.toFailure();
    }

    const targetFile = this.getEditTarget(cwd, options.scope);
    const readResult = this.repository.read(targetFile);
    if (!readResult.ok) {
      bag.mergeArray(readResult.diagnostics);
      return bag.toFailure();
    }

    const cloned = structuredClone(readResult.value.values);
    deleteValueByPath(cloned, pathToProperty);

    const validation = partialConfigSchema.safeParse(cloned);
    if (!validation.success) {
      for (const issue of validation.error.issues) {
        bag.add(createConfigInvalidValueDiagnostic(issue.path.join('.'), issue.message));
      }
      return bag.toFailure();
    }

    return ok({ file: targetFile, values: cloned });
  }

  getEditTarget(cwd: string, scope?: ConfigScope): string {
    if (scope === 'global') {
      return this.pathResolver.resolve(cwd).globalFile;
    }

    if (scope === 'local') {
      return this.pathResolver.resolveLocalWriteTarget(cwd);
    }

    const inferredScope: ConfigScope = this.pathResolver.isInProject(cwd) ? 'local' : 'global';
    return this.getEditTarget(cwd, inferredScope);
  }

  toDisplayPath(cwd: string, filePath: string) {
    const relative = path.relative(path.resolve(cwd), filePath);
    return relative.startsWith('..') ? filePath : `.${path.sep}${relative}`;
  }
}
