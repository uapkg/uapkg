import { resolveUapkgBuildMode } from '@uapkg/common';
import { PackageVersionSchema, RegistryURLSchema } from '@uapkg/common-schema';
import { z } from 'zod';

const DEVELOPMENT_REGISTRY_URL = 'https://github.com/uapkg/registry-dev-tmp';
const PRODUCTION_REGISTRY_URL = 'https://github.com/uapkg/registry';

// Accepted postinstall policy values. The `prompt` value is intentionally
// omitted — uapkg commands must remain non-interactive.
const postInstallPolicySchema = z.enum(['allow', 'deny']);
const registryUrlConfigSchema = RegistryURLSchema.transform((value): string => value);

// The native launcher reads only this subtree in the active global profile.
// Normal CLI config resolution still supports project-local overrides.
const launcherConfigSchema = z
  .object({
    cliSource: z.enum(['github-releases', 'npm']),
    defaultCliVersion: PackageVersionSchema.optional(),
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
     * Per-registry override of `install.postInstallPolicy`. When omitted the
     * global policy applies. Resolution is "nearest wins": per-registry
     * overrides the global value.
     */
    postInstallPolicy: postInstallPolicySchema.optional(),
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
    postInstallPolicy: postInstallPolicySchema.optional(),
  })
  .strict();

export const configSchema = z
  .object({
    registry: z.string().min(1),
    registries: z.record(z.string(), registryConfigSchema),
    launcher: launcherConfigSchema,
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
         * Global postinstall policy. Default: `deny` (postinstall hooks are
         * treated as authoritative bootstrap documentation and require explicit
         * opt-in). Per-registry overrides apply via `registries.<name>.postInstallPolicy`.
         */
        postInstallPolicy: postInstallPolicySchema,
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
        postInstallPolicy: postInstallPolicySchema.optional(),
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
export type PostInstallPolicyValue = ResolvedConfig['install']['postInstallPolicy'];

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
      cliSource: 'github-releases',
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
      postInstallPolicy: 'deny',
    },
    term: {
      quiet: false,
      verbose: false,
    },
  };

  return configSchema.parse(defaults);
}
