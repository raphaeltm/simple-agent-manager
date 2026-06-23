import { type ImageResolver, isDigestReference } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { createImageResolver, ImageResolveError } from '../services/image-resolver';
import { mintProjectRegistryCredential } from '../services/registry-credentials';

type ResolveImageResult =
  | { success: true; body: unknown }
  | { success: false; errors: Array<{ path: string; message: string }> };

export async function buildProjectImageResolver(
  env: Env,
  projectId: string,
  userId: string,
): Promise<ImageResolver> {
  let registryCreds: { username: string; password: string } | undefined;
  let registryAuthHost: string | undefined;

  try {
    const creds = await mintProjectRegistryCredential(
      env, projectId, userId, '', undefined,
      { permissions: ['pull'] },
    );
    registryCreds = { username: creds.username, password: creds.password };
    // Scope the minted credentials to the SAM registry host only. A manifest
    // may name an arbitrary, user-controlled registry; without this scope the
    // resolver would forward SAM-minted Basic-auth creds to that host.
    registryAuthHost = creds.registry;
  } catch {
    // Best-effort: public registries work without auth.
  }

  return createImageResolver({
    auth: registryCreds,
    authRegistryHost: registryAuthHost,
  });
}

/**
 * Walk the manifest body's services and resolve any tag-based image
 * references to digest-pinned references.
 *
 * Accepts manifests where `image.digest` contains either:
 * - A sha256 digest (already pinned — left as-is)
 * - A tag (e.g. "v1.0", "latest") — resolved via registry API
 *
 * Also accepts `image.tag` as an explicit field (digest takes precedence).
 *
 * Uses minted registry credentials for private images pushed through
 * the SAM registry (best-effort; falls back to unauthenticated).
 */
export async function resolveManifestImageTags(
  body: unknown,
  projectId: string,
  userId: string,
  env: Env,
): Promise<ResolveImageResult> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { success: true, body }; // let validateManifest handle shape errors
  }

  const root = body as Record<string, unknown>;
  const services = root['services'];
  if (typeof services !== 'object' || services === null || Array.isArray(services)) {
    return { success: true, body }; // let validateManifest handle
  }

  const svcMap = services as Record<string, unknown>;
  let needsRewrite = false;

  for (const svcConfig of Object.values(svcMap)) {
    if (typeof svcConfig !== 'object' || svcConfig === null) continue;
    const svc = svcConfig as Record<string, unknown>;
    const image = svc['image'];
    if (typeof image !== 'object' || image === null) continue;
    const img = image as Record<string, unknown>;
    const digest = img['digest'] as string | undefined;
    const tag = img['tag'] as string | undefined;

    if (tag && !digest) {
      needsRewrite = true;
      break;
    }
    if (digest && !isDigestReference(digest)) {
      needsRewrite = true;
      break;
    }
  }

  if (!needsRewrite) {
    return { success: true, body };
  }

  const resolver = await buildProjectImageResolver(env, projectId, userId);
  const resolveErrors: Array<{ path: string; message: string }> = [];
  const resolvedBody = structuredClone(root);
  const resolvedServices = resolvedBody['services'] as Record<string, Record<string, unknown>>;

  for (const [name, svcConfig] of Object.entries(resolvedServices)) {
    if (typeof svcConfig !== 'object' || svcConfig === null) continue;
    const image = svcConfig['image'];
    if (typeof image !== 'object' || image === null) continue;
    const img = image as Record<string, unknown>;

    const registry = img['registry'] as string;
    const repository = img['repository'] as string;
    const digest = img['digest'] as string | undefined;
    const tag = img['tag'] as string | undefined;

    if (!registry || !repository) continue;

    let tagToResolve: string | undefined;
    if (tag && (!digest || !isDigestReference(digest))) {
      tagToResolve = tag;
    } else if (digest && !isDigestReference(digest)) {
      tagToResolve = digest;
    }

    if (!tagToResolve) continue;

    try {
      const resolvedDigest = await resolver(registry, repository, tagToResolve);
      img['digest'] = resolvedDigest;
      delete img['tag'];

      log.info('release.image_resolved', {
        service: name,
        registry,
        repository,
        tag: tagToResolve,
        digest: resolvedDigest,
      });
    } catch (err) {
      const message = err instanceof ImageResolveError
        ? err.message
        : `Failed to resolve ${registry}/${repository}:${tagToResolve}: ${err instanceof Error ? err.message : String(err)}`;
      resolveErrors.push({ path: `services.${name}.image`, message });
    }
  }

  if (resolveErrors.length > 0) {
    return { success: false, errors: resolveErrors };
  }

  return { success: true, body: resolvedBody };
}
