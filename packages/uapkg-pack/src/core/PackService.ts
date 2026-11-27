import fs from 'node:fs';
import path from 'node:path';
import {
  createLfsSkippedDiagnostic,
  createNoFilesSelectedDiagnostic,
  createOutFileIsDirectoryDiagnostic,
  createUnresolvedLfsDiagnostic,
  DiagnosticBag,
  ok,
  type Result,
} from '@uapkg/diagnostics';
import Log, { createLogger } from '@uapkg/log';
import semver from 'semver';
import type { PackOptions, PackResult } from '#pack/contracts/PackTypes.ts';
import { FileCrawler } from '#pack/core/FileCrawler.ts';
import { IgnoreEvaluator } from '#pack/core/IgnoreEvaluator.ts';
import { IgnoreRuleLoader } from '#pack/core/IgnoreRuleLoader.ts';
import { IntegrityWriter } from '#pack/core/IntegrityWriter.ts';
import { LFSPointerDetector } from '#pack/core/LFSPointerDetector.ts';
import { PackArtifactExcluder } from '#pack/core/PackArtifactExcluder.ts';
import { PackManifestReader } from '#pack/core/PackManifestReader.ts';
import { excludedPackagePaths, releaseEntryFiles, runPrepack } from '#pack/core/PackLifecycle.ts';
import { PluginDescriptorGuard } from '#pack/core/PluginDescriptorGuard.ts';
import { PluginRootResolver } from '#pack/core/PluginRootResolver.ts';
import { TarArchiveWriter } from '#pack/core/TarArchiveWriter.ts';

export class PackService {
  private readonly logger = createLogger({ context: 'pack' });

  constructor(
    private readonly rootResolver = new PluginRootResolver(),
    private readonly manifestReader = new PackManifestReader(),
    private readonly fileCrawler = new FileCrawler(),
    private readonly ruleLoader = new IgnoreRuleLoader(),
    private readonly ignoreEvaluator = new IgnoreEvaluator(),
    private readonly artifactExcluder = new PackArtifactExcluder(),
    private readonly descriptorGuard = new PluginDescriptorGuard(),
    private readonly lfsPointerDetector = new LFSPointerDetector(),
    private readonly tarWriter = new TarArchiveWriter(),
    private readonly integrityWriter = new IntegrityWriter(),
  ) {}

  async pack(options: PackOptions = {}): Promise<Result<PackResult>> {
    const bag = new DiagnosticBag();
    const cwd = options.cwd ?? process.cwd();

    const rootsResult = this.rootResolver.resolve(cwd);
    if (!rootsResult.ok) {
      bag.mergeArray(rootsResult.diagnostics);
      return bag.toFailure();
    }
    const roots = rootsResult.value;

    const manifestResult = this.manifestReader.read(roots.pluginRoot);
    if (!manifestResult.ok) {
      bag.mergeArray(manifestResult.diagnostics);
      return bag.toFailure();
    }
    try {
      await runPrepack(roots.pluginRoot, manifestResult.value, options);
    } catch (error) {
      bag.addError('PACK_PREPACK_FAILED', String(error), { pluginRoot: roots.pluginRoot });
      return bag.toFailure();
    }
    // The author hook may generate metadata or change package contents.
    const releaseManifest = this.manifestReader.read(roots.pluginRoot);
    if (!releaseManifest.ok) return releaseManifest;
    const manifest = releaseManifest.value;

    // Installers strip one archive component, including for scoped package names.
    const rootPrefix = `${encodeURIComponent(manifest.name)}-${semver.clean(manifest.version)}`;

    const archivePathResult = this.resolveArchivePath(roots.cwd, options.outFile);
    if (!archivePathResult.ok) {
      bag.mergeArray(archivePathResult.diagnostics);
      return bag.toFailure();
    }
    const archivePath = archivePathResult.value;

    let excluded: (file: string) => boolean;
    let runtimeFiles: Set<string>;
    try {
      excluded = excludedPackagePaths(roots.pluginRoot, manifest);
      runtimeFiles = await releaseEntryFiles(roots.pluginRoot, manifest, excluded);
    } catch (error) {
      bag.addError('PACK_LIFECYCLE_INVALID', String(error), { pluginRoot: roots.pluginRoot });
      return bag.toFailure();
    }
    const crawlResult = this.fileCrawler.collect(roots.pluginRoot, excluded);
    if (!crawlResult.ok) {
      bag.mergeArray(crawlResult.diagnostics);
      return bag.toFailure();
    }

    const allFiles = crawlResult.value;
    const descriptorResult = this.descriptorGuard.validate(roots.pluginRoot, allFiles);
    if (!descriptorResult.ok) {
      bag.mergeArray(descriptorResult.diagnostics);
      return bag.toFailure();
    }

    const generatedArtifacts = this.artifactExcluder.collect(roots.pluginRoot, archivePath, allFiles);
    const rules = this.ruleLoader.load(roots.gitRoot, roots.pluginRoot);

    const filtered = allFiles.filter((file) => {
      if (generatedArtifacts.has(file.relativePath)) {
        return false;
      }

      const ignored = this.ignoreEvaluator.shouldIgnore(file.relativePath, file.absolutePath, rules);

      if (!ignored) {
        return true;
      }

      return runtimeFiles.has(file.relativePath);
    });

    const included: string[] = [];
    let skippedLfs = false;

    for (const file of filtered) {
      if (file.relativePath === 'uapkg.json') {
        included.push(file.relativePath);
        continue;
      }

      if (this.lfsPointerDetector.isPointerFile(file.absolutePath)) {
        if (options.allowMissingLfs === true) {
          bag.add(createLfsSkippedDiagnostic(file.relativePath));
          this.logger.warn(`[LFS] Skipping unresolved LFS file: ${file.relativePath}`);
          skippedLfs = true;
          continue;
        }

        bag.add(createUnresolvedLfsDiagnostic(file.relativePath));
        return bag.toFailure();
      }

      included.push(file.relativePath);
    }

    if (!included.includes('uapkg.json')) {
      included.unshift('uapkg.json');
    }
    for (const entry of runtimeFiles) {
      if (!included.includes(entry)) {
        bag.addError(
          'PACK_LIFECYCLE_INPUT_MISSING',
          'Required lifecycle file cannot be included in the archive: ' + entry,
          { file: entry },
        );
        return bag.toFailure();
      }
    }
    if (!included.some((file) => !file.includes('/') && file.toLowerCase().endsWith('.uplugin'))) {
      bag.addError(
        'PACK_DESCRIPTOR_EXCLUDED',
        'The plugin descriptor in the package root must be included in the archive.',
        { pluginRoot: roots.pluginRoot },
      );
      return bag.toFailure();
    }

    const withoutManifest = included.filter((file) => file !== 'uapkg.json');
    if (withoutManifest.length === 0) {
      bag.add(createNoFilesSelectedDiagnostic());
      return bag.toFailure();
    }

    const uniqueIncluded = [...new Set(included)].filter((file) => file !== 'uapkg.lock');
    const sortedFiles = [...uniqueIncluded].sort((left, right) =>
      `${rootPrefix}/${left}`.localeCompare(`${rootPrefix}/${right}`),
    );

    if (skippedLfs) {
      this.logger.warn("[LFS] The package may be incomplete. Run 'git lfs pull' or exclude via '.uapkgignore'.");
    }

    if (options.dryRun === true) {
      for (const relativePath of sortedFiles) {
        this.logger.info(`${rootPrefix}/${relativePath}`);
      }

      return ok({
        pluginRoot: roots.pluginRoot,
        archivePath,
        files: sortedFiles,
        warnings: bag
          .all()
          .filter((d) => d.level === 'warning')
          .map((d) => d.message),
        dryRun: true,
      });
    }

    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    await this.tarWriter.write({
      archivePath,
      pluginRoot: roots.pluginRoot,
      rootPrefix,
      files: sortedFiles,
    });

    const integrityPath = this.integrityWriter.write(archivePath);
    Log.info(`[uapkg] Packed ${sortedFiles.length} files into ${archivePath}`);

    return ok({
      pluginRoot: roots.pluginRoot,
      archivePath,
      integrityPath,
      files: sortedFiles,
      warnings: bag
        .all()
        .filter((d) => d.level === 'warning')
        .map((d) => d.message),
      dryRun: false,
    });
  }

  private resolveArchivePath(cwd: string, outFile?: string): Result<string> {
    const resolved = outFile ? path.resolve(cwd, outFile) : path.resolve(cwd, 'package.tgz');

    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return { ok: false, diagnostics: [createOutFileIsDirectoryDiagnostic(resolved)] };
    }

    return ok(resolved);
  }
}
