import { parse } from 'semver';
import { z } from 'zod';
import type { Brand } from '#common-schema/brand/Brand.ts';

export type CliVersionSelector = Brand<string, 'CliVersionSelector'>;

/** CLI routing selectors are separate from package versions and dependency ranges. */
export const CliVersionSelectorSchema = z
  .string()
  .refine(
    (value) => {
      if (value === 'latest') return true;
      const parsed = parse(value);
      if (!parsed) return false;
      const build = parsed.build.length ? `+${parsed.build.join('.')}` : '';
      if (value !== `${parsed.version}${build}`) return false;
      if (!parsed.prerelease.length) return true;
      const preview = parsed.prerelease.join('.');
      return /^(alpha|beta)\.(0|[1-9]\d*)$/.test(preview) || (!build && /^(alpha|beta)$/.test(preview));
    },
    { message: 'Expected an exact CLI version, latest, or a version-scoped alpha/beta alias' },
  )
  .brand('CliVersionSelector');
