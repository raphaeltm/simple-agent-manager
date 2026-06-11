/**
 * Manifest Resolver
 *
 * Takes an UnresolvedManifest (with tag-based image references) and
 * an injectable ImageResolver to produce a fully resolved DeploymentManifest
 * validated against the Zod schema.
 */

import { DeploymentManifestSchema } from '../deployment-manifest/schema';
import { isDigestReference } from './parse';
import type { ComposeParseError, ComposeResolveResult, ImageResolver, UnresolvedManifest } from './types';

/**
 * Resolve all image references in an UnresolvedManifest from tags to digests,
 * then validate the result against the DeploymentManifest schema.
 */
export async function resolveManifest(
  unresolved: UnresolvedManifest,
  resolver: ImageResolver,
): Promise<ComposeResolveResult> {
  const errors: ComposeParseError[] = [];

  // Resolve all image tags to digests
  const resolvedServices: Record<string, unknown> = {};

  for (const [name, service] of Object.entries(unresolved.services)) {
    const { image } = service;
    let digest: string;

    if (isDigestReference(image.reference)) {
      // Already a digest — use as-is
      digest = image.reference;
    } else {
      // Resolve the tag to a digest
      try {
        digest = await resolver(image.registry, image.repository, image.reference);
      } catch (e) {
        errors.push({
          path: `services.${name}.image`,
          message: `Failed to resolve image ${image.registry}/${image.repository}:${image.reference}: ${e instanceof Error ? e.message : String(e)}`,
        });
        continue;
      }

      // Validate the resolved digest format
      if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
        errors.push({
          path: `services.${name}.image`,
          message: `Resolver returned an invalid digest "${digest}" for ${image.registry}/${image.repository}:${image.reference}. Expected sha256:<64 hex chars>.`,
        });
        continue;
      }
    }

    resolvedServices[name] = {
      image: {
        registry: image.registry,
        repository: image.repository,
        digest,
      },
      ...(service.command ? { command: service.command } : {}),
      env: service.env,
      volumes: service.volumes,
      ...(service.resources ? { resources: service.resources } : {}),
      ...(service.healthCheck ? { healthCheck: service.healthCheck } : {}),
    };
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  // Build the resolved manifest
  const resolved = {
    version: unresolved.version,
    services: resolvedServices,
    volumes: unresolved.volumes,
    routes: unresolved.routes,
    ...(unresolved.hooks ? { hooks: unresolved.hooks } : {}),
  };

  // Validate against the Zod schema
  const result = DeploymentManifestSchema.safeParse(resolved);
  if (!result.success) {
    return {
      success: false,
      errors: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  return { success: true, manifest: result.data };
}
