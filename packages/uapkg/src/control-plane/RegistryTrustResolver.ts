import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeUrl } from '@uapkg/common';
import { DEFAULT_REGISTRY_ALIAS } from '@uapkg/common-schema';
import { getRegistryRepoPath } from '@uapkg/registry-core';
import { RegistryMetaSchema } from '@uapkg/registry-schema';
import type { CompositionRoot } from '#cli/app/CompositionRoot.ts';
import {
  type RegistryTrust,
  registryAudience,
  UAPKG_AUTHORIZATION_ISSUER,
  UAPKG_CONTROL_PLANE_API,
} from '#cli/control-plane/ControlPlaneTypes.ts';

export class RegistryTrustResolver {
  public constructor(private readonly root: CompositionRoot) {}

  public async resolve(requestedAlias?: string): Promise<RegistryTrust> {
    const alias = requestedAlias ?? DEFAULT_REGISTRY_ALIAS;
    const result = this.root.registryCore.getOrCreateRegistry(alias);
    if (!result.ok) {
      throw new Error(firstDiagnostic(result.diagnostics, `Registry "${alias}" is not configured.`));
    }

    const registry = result.value;
    const updated = await registry.ensureUpToDate({
      logicalRegistryName: alias,
      bypassFreshnessCheck: true,
    });
    if (!updated.ok || updated.value === 'Failed') {
      throw new Error(firstDiagnostic(updated.diagnostics, `Unable to update registry "${alias}".`));
    }

    const metadataPath = join(getRegistryRepoPath(registry.shortId), '.uapkg', 'registry.meta.json');
    let raw: string;
    try {
      raw = await readFile(metadataPath, 'utf8');
    } catch (error) {
      throw new Error(
        `Registry "${alias}" does not contain .uapkg/registry.meta.json. It cannot be used for authenticated control-plane commands.`,
        { cause: error },
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`Registry metadata for "${alias}" is not valid JSON.`, { cause: error });
    }
    const parsed = RegistryMetaSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`Registry metadata for "${alias}" does not match the supported schema.`);
    }

    const repositoryUrl = canonicalizeRegistryGitOrigin(registry.descriptor.url);
    return {
      alias,
      registryId: parsed.data.registry.id,
      registryName: parsed.data.registry.name,
      repositoryUrl,
      repositoryFingerprint: fingerprintRegistryGitOrigin(repositoryUrl),
      issuer: UAPKG_AUTHORIZATION_ISSUER,
      apiBaseUrl: UAPKG_CONTROL_PLANE_API,
      resource: registryAudience(parsed.data.registry.id),
      cacheShortId: registry.shortId,
    };
  }

  public async forceRefresh(trust: RegistryTrust): Promise<void> {
    const result = this.root.registryCore.getOrCreateRegistry(trust.alias);
    if (!result.ok) {
      throw new Error(firstDiagnostic(result.diagnostics, `Registry "${trust.alias}" is not configured.`));
    }
    const updated = await result.value.ensureUpToDate({
      logicalRegistryName: trust.alias,
      bypassFreshnessCheck: true,
    });
    if (!updated.ok || updated.value === 'Failed') {
      throw new Error(firstDiagnostic(updated.diagnostics, `Unable to refresh registry "${trust.alias}".`));
    }
  }
}

/**
 * GitHub accepts HTTPS, SSH URL, and SCP-like clone coordinates for the same
 * repository. Control-plane authorization must bind all three spellings to one
 * stable source identity.
 */
export function canonicalizeRegistryGitOrigin(origin: string): string {
  const value = origin.trim();
  const scpLike = /^(?:git@)?github\.com:([^/\s]+)\/([^/\s]+?)\/?$/i.exec(value);
  if (scpLike) {
    return canonicalGitHubRepository(scpLike[1], scpLike[2]);
  }

  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase() === 'github.com') {
      const path = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
      if (path.length !== 2) {
        throw new Error('A GitHub registry origin must identify exactly one owner and repository.');
      }
      return canonicalGitHubRepository(path[0], path[1]);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('A GitHub registry origin')) {
      throw error;
    }
  }

  return normalizeUrl(value);
}

export function fingerprintRegistryGitOrigin(origin: string): string {
  const canonical = canonicalizeRegistryGitOrigin(origin);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function canonicalGitHubRepository(owner: string, repository: string): string {
  const normalizedOwner = owner.trim().toLowerCase();
  const normalizedRepository = repository
    .trim()
    .replace(/\.git$/i, '')
    .toLowerCase();
  if (!normalizedOwner || !normalizedRepository) {
    throw new Error('A GitHub registry origin must include an owner and repository.');
  }
  return `https://github.com/${normalizedOwner}/${normalizedRepository}.git`;
}

function firstDiagnostic(diagnostics: readonly { readonly message: string }[], fallback: string): string {
  return diagnostics[0]?.message ?? fallback;
}
