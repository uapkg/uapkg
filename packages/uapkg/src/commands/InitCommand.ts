import type { PackageName, PackageVersion } from '@uapkg/common-schema';
import { PackageNameSchema, PackageVersionSchema } from '@uapkg/common-schema';
import { ManifestReader, ManifestWriter } from '@uapkg/package-manifest';
import type { Manifest, ManifestKind } from '@uapkg/package-manifest-schema';
import type { CompositionRoot } from '#cli/app/CompositionRoot.ts';
import { UAPKG_BUILD_METADATA } from '#cli/build/BuildMetadata.ts';
import type { ProjectContextDetector } from '#cli/prompts/ProjectContextDetector.ts';
import type { PromptService } from '#cli/prompts/PromptService.ts';
import type { Command } from '#cli/commands/Command.ts';

export interface InitCommandOptions {
  readonly explicitKind?: ManifestKind;
  readonly explicitName?: string;
}

// ---------------------------------------------------------------------------
// InitCommand — creates a minimal `uapkg.json` (new schema) for the current
// working directory, interactively selecting `kind` + `name` when missing.
//
// - Writes via `@uapkg/package-manifest` ManifestWriter.
// - Pre-check uses ManifestReader (fails fast if manifest already present).
// ---------------------------------------------------------------------------

const DEFAULT_INITIAL_VERSION = '0.1.0';

export class InitCommand implements Command {
  public constructor(
    private readonly root: CompositionRoot,
    private readonly options: InitCommandOptions,
    private readonly detector: ProjectContextDetector,
    private readonly prompts: PromptService,
  ) {}

  public async execute(): Promise<number> {
    const existing = await new ManifestReader().read(this.root.cwd);
    if (existing.ok) {
      process.stderr.write('[uapkg] uapkg.json already exists in current directory\n');
      return 1;
    }

    const detected = this.detector.detect(this.root.cwd);
    const kind =
      this.options.explicitKind ??
      ((await this.prompts.select(
        'Manifest type',
        [
          { label: 'Project', value: 'project' },
          { label: 'Plugin', value: 'plugin' },
        ],
        detected.suggestedKind,
      )) as ManifestKind);

    const rawName = this.options.explicitName ?? (await this.prompts.text('Package name', detected.suggestedName));

    const nameResult = PackageNameSchema.safeParse(rawName.trim());
    if (!nameResult.success) {
      process.stderr.write(
        `[uapkg] Invalid package name "${rawName}": use lowercase letters, digits, and hyphens, optionally scoped as @owner/package (214 characters maximum)\n`,
      );
      return 1;
    }
    const versionResult = PackageVersionSchema.safeParse(DEFAULT_INITIAL_VERSION);
    if (!versionResult.success) {
      process.stderr.write(`[uapkg] Internal error: default version "${DEFAULT_INITIAL_VERSION}" rejected by schema\n`);
      return 1;
    }

    const manifest: Manifest = this.buildManifest(kind, nameResult.data, versionResult.data);
    const writeResult = await new ManifestWriter().write(this.root.cwd, manifest);
    if (!writeResult.ok) {
      this.root.diagnostics.reportAll(writeResult.diagnostics);
      return 1;
    }

    process.stdout.write(`[uapkg] Created uapkg.json (${kind}) for ${String(nameResult.data)}\n`);
    return 0;
  }

  private buildManifest(kind: ManifestKind, name: PackageName, version: PackageVersion): Manifest {
    if (kind === 'plugin') {
      return { name, version, kind: 'plugin' };
    }
    return {
      name,
      version,
      kind: 'project',
      uapkgVersion: PackageVersionSchema.parse(UAPKG_BUILD_METADATA.packageVersion),
    };
  }
}
