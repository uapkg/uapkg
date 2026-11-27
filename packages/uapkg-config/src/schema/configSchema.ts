import { DEFAULT_PACKAGE_MINIMUM_RELEASE_AGE, parseReleaseAgeMilliseconds, resolveUapkgBuildMode } from '@uapkg/common';
import { CliVersionSelectorSchema, DurationStringSchema, RegistryURLSchema } from '@uapkg/common-schema';
import { z } from 'zod';

const DEVELOPMENT_REGISTRY_URL = 'https://github.com/uapkg/registry-dev-tmp';
const PRODUCTION_REGISTRY_URL = 'https://github.com/uapkg/registry';

// Accepted lifecycle policy values. The `prompt` value is intentionally
// omitted — uapkg commands must remain non-interactive.
const lifecyclePolicySchema = z.enum(['allow', 'deny']);
const registryUrlConfigSchema = RegistryURLSchema.transform((value): string => value);

// Shared with the native reader through the generated slim schema.
export const launcherConfigSchema = z
  .object({
    defaultCliVersion: CliVersionSelectorSchema.describe('a CLI version selector such as latest or 1.2.3').optional(),
    autoLauncherUpdate: z.boolean().describe('a boolean (true or false)').optional(),
    autoCLIUpdate: z.boolean().describe('a boolean (true or false)').optional(),
    autoUpdate: z
      .object({
        minimumReleaseAge: DurationStringSchema.describe(
          'Minimum release age for automatic updates. Supports weeks, days, hours, minutes, and seconds in descending order; 0 disables the cooldown.',
        ).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const packageReleaseAgeSchema = DurationStringSchema.refine(
  (value) => parseReleaseAgeMilliseconds(value) !== undefined,
  {
    when: ({ issues }) => issues.length === 0,
    error: 'This duration is too long. Use a shorter duration, such as 3d',
  },
).describe('a duration using w, d, h, m, s in that order (such as 1d12h), or 0 to disable the cooldown');

export const packagesConfigSchema = z
  .object({
    resolution: z
      .object({
        minimumReleaseAge: packageReleaseAgeSchema.optional(),
        applyReleaseAgeToNewPackages: z.boolean().describe('a boolean (true or false)').optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const registryRefSchema = z
  .object({
    type: z.enum(['branch', 'tag', 'rev']),
    value: z.string().min(1),
  })
  .strict();

const registryConfigSchema = z
  .object({
    url: registryUrlConfigSchema,
    ref: registryRefSchema.default({
      type: 'branch',
      value: 'main',
    }),
    ttlSeconds: z.number().optional(),
    /**
     * Per-registry override of `install.lifecyclePolicy`. When omitted the
     * global policy applies. Resolution is "nearest wins": per-registry
     * overrides the global value.
     */
    lifecyclePolicy: lifecyclePolicySchema.optional(),
  })
  .strict();

const partialRegistryRefSchema = z
  .object({
    type: z.enum(['branch', 'tag', 'rev']).optional(),
    value: z.string().min(1).optional(),
  })
  .strict();

const partialRegistryConfigSchema = z
  .object({
    url: registryUrlConfigSchema.optional(),
    ref: partialRegistryRefSchema.optional(),
    ttlSeconds: z.number().optional(),
    lifecyclePolicy: lifecyclePolicySchema.optional(),
  })
  .strict();

export const configSchema = z
  .object({
    registry: z.string().min(1),
    registries: z.record(z.string(), registryConfigSchema),
    launcher: launcherConfigSchema,
    packages: packagesConfigSchema,
    git: z.string().min(1),
    editor: z.string().min(1),
    exec: z
      .object({
        shell: z.string().min(1),
      })
      .strict(),
    cache: z
      .object({
        enabled: z.boolean(),
      })
      .strict(),
    registryCache: z
      .object({
        ttlSeconds: z.number(),
      })
      .strict(),
    network: z
      .object({
        retries: z.number(),
        timeout: z.number(),
        /**
         * Maximum number of simultaneous asset downloads the installer will
         * perform. Must be >= 1. Default: 5.
         */
        maxConcurrentDownloads: z.number().int().min(1),
      })
      .strict(),
    install: z
      .object({
        /**
         * Default permission for a verified release without a workspace rule.
         * A configured registry can override this fallback.
         */
        lifecyclePolicy: lifecyclePolicySchema,
      })
      .strict(),
    term: z
      .object({
        quiet: z.boolean(),
        verbose: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const partialConfigSchema = z
  .object({
    registry: z.string().min(1).optional(),
    registries: z.record(z.string(), partialRegistryConfigSchema).optional(),
    launcher: launcherConfigSchema.partial().optional(),
    packages: packagesConfigSchema.partial().optional(),
    git: z.string().min(1).optional(),
    editor: z.string().min(1).optional(),
    exec: z
      .object({
        shell: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    cache: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    registryCache: z
      .object({
        ttlSeconds: z.number().optional(),
      })
      .strict()
      .optional(),
    network: z
      .object({
        retries: z.number().optional(),
        timeout: z.number().optional(),
        maxConcurrentDownloads: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
    install: z
      .object({
        lifecyclePolicy: lifecyclePolicySchema.optional(),
      })
      .strict()
      .optional(),
    term: z
      .object({
        quiet: z.boolean().optional(),
        verbose: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ResolvedConfig = z.infer<typeof configSchema>;
export type PartialConfig = z.infer<typeof partialConfigSchema>;
export type RegistryConfig = ResolvedConfig['registries'][string];
export type RegistryRef = RegistryConfig['ref'];
export type LifecyclePolicyValue = ResolvedConfig['install']['lifecyclePolicy'];

function resolveEditorDefault() {
  if (process.env.EDITOR) {
    return process.env.EDITOR;
  }

  if (process.env.VISUAL) {
    return process.env.VISUAL;
  }

  if (process.platform === 'win32') {
    const systemRoot = process.env.SYSTEMROOT ?? 'C:\\Windows';
    return `${systemRoot}\\notepad.exe`;
  }

  return 'vi';
}

function resolveShellDefault() {
  return process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
}

export function getDefaultConfig(): ResolvedConfig {
  const defaultRegistryUrl =
    resolveUapkgBuildMode() === 'development' ? DEVELOPMENT_REGISTRY_URL : PRODUCTION_REGISTRY_URL;
  const defaults: ResolvedConfig = {
    registry: 'default',
    launcher: {
      defaultCliVersion: CliVersionSelectorSchema.parse('latest'),
      autoLauncherUpdate: true,
      autoCLIUpdate: true,
      autoUpdate: { minimumReleaseAge: DurationStringSchema.parse('3d') },
    },
    packages: {
      resolution: {
        minimumReleaseAge: DurationStringSchema.parse(DEFAULT_PACKAGE_MINIMUM_RELEASE_AGE),
        applyReleaseAgeToNewPackages: true,
      },
    },
    registries: {
      default: {
        url: registryUrlConfigSchema.parse(defaultRegistryUrl),
        ref: {
          type: 'branch',
          value: 'main',
        },
      },
    },
    git: 'git',
    editor: resolveEditorDefault(),
    exec: {
      shell: resolveShellDefault(),
    },
    cache: {
      enabled: true,
    },
    registryCache: {
      ttlSeconds: 300,
    },
    network: {
      retries: 2,
      timeout: 300,
      maxConcurrentDownloads: 5,
    },
    install: {
      lifecyclePolicy: 'deny',
    },
    term: {
      quiet: false,
      verbose: false,
    },
  };

  return configSchema.parse(defaults);
}
