/**
 * Deployment release routes.
 *
 * Scoped under /api/projects/:projectId/environments/:envId/releases.
 * Auth: session cookie + active project membership/capabilities.
 */

import { parseCompose, resolveManifest, validateManifest } from '@simple-agent-manager/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectAccess, requireProjectCapability } from '../middleware/project-auth';
import { collectSecretNames, renderCompose } from '../services/compose-renderer';
import { buildDeploymentRouteTargets } from '../services/deployment-routing';
import { decrypt } from '../services/encryption';
import {
  buildProjectImageResolver,
  resolveManifestImageTags,
} from './deployment-release-image-resolver';
import { createDeploymentReleaseFromManifest } from './deployment-release-submission';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Load an environment row and verify it belongs to the project.
 */
async function requireOwnedEnvironment(
  db: ReturnType<typeof drizzle>,
  envId: string,
  projectId: string,
) {
  const rows = await db
    .select()
    .from(schema.deploymentEnvironments)
    .where(
      and(
        eq(schema.deploymentEnvironments.id, envId),
        eq(schema.deploymentEnvironments.projectId, projectId),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    throw errors.notFound('Deployment environment');
  }
  return rows[0];
}

/**
 * Load a release row and verify it belongs to the environment.
 */
async function requireOwnedRelease(
  db: ReturnType<typeof drizzle>,
  releaseId: string,
  envId: string,
) {
  const rows = await db
    .select()
    .from(schema.deploymentReleases)
    .where(
      and(
        eq(schema.deploymentReleases.id, releaseId),
        eq(schema.deploymentReleases.environmentId, envId),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    throw errors.notFound('Deployment release');
  }
  const release = rows[0];
  if (!release) {
    throw errors.notFound('Deployment release');
  }
  return release;
}

export function getEncryptionKey(env: Env): string {
  return env.CREDENTIAL_ENCRYPTION_KEY ?? env.ENCRYPTION_KEY;
}

/**
 * Load and decrypt secrets for an environment.
 * Returns a map of secret name → decrypted value.
 */
export async function loadResolvedSecrets(
  db: ReturnType<typeof drizzle>,
  envId: string,
  secretNames: string[],
  encryptionKey: string,
): Promise<Record<string, string>> {
  if (secretNames.length === 0) return {};

  const rows = await db
    .select({
      name: schema.deploymentSecrets.name,
      encryptedValue: schema.deploymentSecrets.encryptedValue,
      iv: schema.deploymentSecrets.iv,
    })
    .from(schema.deploymentSecrets)
    .where(
      and(
        eq(schema.deploymentSecrets.environmentId, envId),
        inArray(schema.deploymentSecrets.name, secretNames),
      ),
    );

  const entries = await Promise.all(
    rows.map(async (row) => [row.name, await decrypt(row.encryptedValue, row.iv, encryptionKey)] as const),
  );
  return Object.fromEntries(entries);
}

// =============================================================================
// Routes
// =============================================================================

const deploymentReleaseRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/projects/:projectId/environments/:envId/releases
 * Submit a manifest to create a new release.
 *
 * Preferred contract: Docker Compose YAML with Content-Type application/yaml,
 * text/yaml, application/x-yaml, or text/x-yaml. Compose is parsed into the
 * normalized manifest, image tags are resolved to digests, then the manifest
 * is validated.
 *
 * Backward-compatible contract: raw manifest JSON with any other content type.
 * JSON manifests keep the existing validateManifest() path.
 *
 * Single-service constraint enforced for slice 2.
 * Secret references are stored by name in the manifest (values never persisted).
 */
deploymentReleaseRoutes.post(
  '/:projectId/environments/:envId/releases',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireProjectCapability(db, projectId, userId, 'deployment:deploy');
    await requireOwnedEnvironment(db, envId, projectId);

    const contentType = c.req.header('Content-Type') ?? '';
    let manifest;

    if (isYamlContentType(contentType)) {
      const yamlText = await c.req.text();
      const parsed = parseCompose(yamlText);
      if (!parsed.success) {
        return c.json(
          {
            error: 'COMPOSE_PARSE_FAILED',
            message: 'Compose parse failed',
            details: { errors: parsed.errors },
          },
          400,
        );
      }

      const resolver = await buildProjectImageResolver(c.env, projectId, userId);
      const resolved = await resolveManifest(parsed.manifest, resolver);
      if (!resolved.success) {
        return c.json(
          {
            error: 'MANIFEST_VALIDATION_FAILED',
            message: 'Manifest validation failed',
            details: { errors: resolved.errors },
          },
          400,
        );
      }

      manifest = resolved.manifest;
    } else {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw errors.badRequest('Invalid JSON in request body');
      }

      const resolveResult = await resolveManifestImageTags(body, projectId, userId, c.env);
      if (!resolveResult.success) {
        return c.json(
          {
            error: 'IMAGE_RESOLVE_FAILED',
            message: 'Failed to resolve image tag(s) to digest(s)',
            details: { errors: resolveResult.errors },
          },
          400,
        );
      }

      const result = validateManifest(resolveResult.body);
      if (!result.success) {
        return c.json(
          {
            error: 'MANIFEST_VALIDATION_FAILED',
            message: 'Manifest validation failed',
            details: { errors: result.errors },
          },
          400,
        );
      }

      manifest = result.manifest;
    }

    let executionCtx;
    try {
      executionCtx = c.executionCtx;
    } catch {
      // Hono unit tests do not provide an ExecutionContext.
    }

    const release = await createDeploymentReleaseFromManifest(db, manifest, {
      envId,
      projectId,
      userId,
      env: c.env,
      executionCtx,
    });
    if (!release.success) {
      return c.json(release.response.body, release.response.status);
    }

    return c.json(release.body, 201);
  },
);

function isYamlContentType(contentType: string): boolean {
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return (
    mediaType === 'application/yaml'
    || mediaType === 'text/yaml'
    || mediaType === 'application/x-yaml'
    || mediaType === 'text/x-yaml'
  );
}

export { buildProjectImageResolver, resolveManifestImageTags };

/**
 * GET /api/projects/:projectId/environments/:envId/releases
 * List releases for an environment (newest first).
 */
deploymentReleaseRoutes.get(
  '/:projectId/environments/:envId/releases',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireProjectAccess(db, projectId, userId);
    await requireOwnedEnvironment(db, envId, projectId);

    const rows = await db
      .select({
        id: schema.deploymentReleases.id,
        environmentId: schema.deploymentReleases.environmentId,
        version: schema.deploymentReleases.version,
        status: schema.deploymentReleases.status,
        createdBy: schema.deploymentReleases.createdBy,
        createdAt: schema.deploymentReleases.createdAt,
      })
      .from(schema.deploymentReleases)
      .where(eq(schema.deploymentReleases.environmentId, envId))
      .orderBy(desc(schema.deploymentReleases.version));

    return c.json({ releases: rows });
  },
);

/**
 * GET /api/projects/:projectId/environments/:envId/releases/:releaseId
 * Get a single release including the stored manifest.
 */
deploymentReleaseRoutes.get(
  '/:projectId/environments/:envId/releases/:releaseId',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const releaseId = c.req.param('releaseId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireProjectAccess(db, projectId, userId);
    await requireOwnedEnvironment(db, envId, projectId);
    const row = await requireOwnedRelease(db, releaseId, envId);

    return c.json({
      ...row,
      manifest: JSON.parse(row.manifest),
    });
  },
);

/**
 * GET /api/projects/:projectId/environments/:envId/releases/:releaseId/compose
 * Render and return the Compose YAML preview for a release.
 *
 * Includes route-target host-port bindings (same as the real apply payload)
 * so the preview is structurally identical to what the node will run.
 *
 * Secret values are MASKED — the preview shows `***` for every secret
 * reference so users can inspect the structure without leaking credentials.
 */
deploymentReleaseRoutes.get(
  '/:projectId/environments/:envId/releases/:releaseId/compose',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const releaseId = c.req.param('releaseId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireProjectAccess(db, projectId, userId);
    await requireOwnedEnvironment(db, envId, projectId);
    const row = await requireOwnedRelease(db, releaseId, envId);

    const manifest = JSON.parse(row.manifest);

    // Build route targets — same derivation as the apply callback so
    // the preview port bindings match what the node actually runs.
    const routes = buildDeploymentRouteTargets(manifest, {
      environmentId: envId,
      baseDomain: c.env.BASE_DOMAIN,
      routePortBase: c.env.DEPLOYMENT_ROUTE_PORT_BASE,
      routePortSpan: c.env.DEPLOYMENT_ROUTE_PORT_SPAN,
    });

    // Mask secret values — preview NEVER contains decrypted credentials.
    // Every referenced secret name is mapped to a masked placeholder.
    const secretNames = collectSecretNames(manifest);
    const maskedSecrets: Record<string, string> = {};
    for (const name of secretNames) {
      maskedSecrets[name] = '***';
    }

    let composeYaml: string;
    try {
      composeYaml = renderCompose(manifest, {
        environmentId: envId,
        releaseId,
        resolvedSecrets: maskedSecrets,
        routeTargets: routes,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes('Missing secrets')) {
        throw errors.badRequest(err.message);
      }
      throw err;
    }

    return c.text(composeYaml, 200, {
      'Content-Type': 'text/yaml; charset=utf-8',
    });
  },
);

export { deploymentReleaseRoutes };
