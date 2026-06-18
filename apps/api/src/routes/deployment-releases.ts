/**
 * Deployment release routes.
 *
 * Scoped under /api/projects/:projectId/environments/:envId/releases.
 * Auth: session cookie + project ownership.
 */

import { isDigestReference, validateManifest } from '@simple-agent-manager/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireOwnedProject } from '../middleware/project-auth';
import { collectSecretNames, renderCompose } from '../services/compose-renderer';
import { provisionDeploymentNode } from '../services/deployment-provisioning';
import { buildDeploymentRouteTargets } from '../services/deployment-routing';
import { decrypt } from '../services/encryption';
import { createImageResolver, ImageResolveError } from '../services/image-resolver';
import { mintProjectRegistryCredential } from '../services/registry-credentials';

// =============================================================================
// Helpers
// =============================================================================

/** Max single-service constraint for slice 2. */
export const MAX_SERVICES_SLICE_2 = 1;

/**
 * Validate a manifest against slice 2 constraints.
 * Returns null if valid, or an error response object if invalid.
 */
export function validateSlice2Constraints(manifest: {
  services: Record<string, { env: Record<string, unknown> }>;
}): { error: string; message: string } | null {
  // Enforce single-service constraint
  const serviceCount = Object.keys(manifest.services).length;
  if (serviceCount > MAX_SERVICES_SLICE_2) {
    return {
      error: 'MULTI_SERVICE_NOT_SUPPORTED',
      message: `Multi-service manifests are not yet supported. This manifest defines ${serviceCount} services, but only ${MAX_SERVICES_SLICE_2} is allowed. Multi-service support arrives in a future update.`,
    };
  }

  return null;
}

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
  return rows[0]!;
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
// Tag → Digest resolution
// =============================================================================

type ResolveImageResult =
  | { success: true; body: unknown }
  | { success: false; errors: Array<{ path: string; message: string }> };

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

  // First pass: check if any images need resolution
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

  // Mint pull-only credentials for querying private registry manifests
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
    // Best-effort: public registries work without auth
  }

  const resolver = createImageResolver({
    auth: registryCreds,
    authRegistryHost: registryAuthHost,
  });

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

    // Determine if resolution is needed
    let tagToResolve: string | undefined;
    if (tag && (!digest || !isDigestReference(digest))) {
      tagToResolve = tag;
    } else if (digest && !isDigestReference(digest)) {
      // digest field contains a tag value
      tagToResolve = digest;
    }

    if (!tagToResolve) continue;

    try {
      const resolvedDigest = await resolver(registry, repository, tagToResolve);
      img['digest'] = resolvedDigest;
      // Remove the tag field if present — manifest schema uses digest only
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

// =============================================================================
// Routes
// =============================================================================

const deploymentReleaseRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/projects/:projectId/environments/:envId/releases
 * Submit a manifest to create a new release.
 *
 * The request body IS the raw manifest JSON.
 * Validated via validateManifest() from @simple-agent-manager/shared.
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
    await requireOwnedProject(db, projectId, userId);
    await requireOwnedEnvironment(db, envId, projectId);

    // Parse body
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw errors.badRequest('Invalid JSON in request body');
    }

    // Phase 0: Resolve tag-based image references to digests.
    // Agents submit manifests with `repo:tag` images; we pin them to
    // immutable `repo@sha256:digest` before validation and persistence.
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
    body = resolveResult.body;

    // Phase 1: Validate manifest (schema + cross-references)
    const result = validateManifest(body);
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

    const manifest = result.manifest;

    // Phase 2: Enforce slice 2 constraints (single-service)
    const constraintError = validateSlice2Constraints(manifest);
    if (constraintError) {
      return c.json(constraintError, 400);
    }

    // Validate that all referenced secrets exist in the environment
    const secretNames = collectSecretNames(manifest);
    if (secretNames.length > 0) {
      const existingSecrets = await db
        .select({ name: schema.deploymentSecrets.name })
        .from(schema.deploymentSecrets)
        .where(eq(schema.deploymentSecrets.environmentId, envId));

      const existingNames = new Set(existingSecrets.map((s) => s.name));
      const missing = secretNames.filter((n) => !existingNames.has(n));

      if (missing.length > 0) {
        return c.json(
          {
            error: 'MISSING_SECRETS',
            message: `Manifest references secrets that do not exist in this environment: ${missing.join(', ')}. Set these secrets before creating a release.`,
            details: { missingSecrets: missing },
          },
          400,
        );
      }
    }

    // Determine next version number
    const latestRelease = await db
      .select({ version: schema.deploymentReleases.version })
      .from(schema.deploymentReleases)
      .where(eq(schema.deploymentReleases.environmentId, envId))
      .orderBy(desc(schema.deploymentReleases.version))
      .limit(1);

    const nextVersion = (latestRelease[0]?.version ?? 0) + 1;

    // Insert release — manifest stores secret REFERENCES (names only), never values
    const id = ulid();
    const now = new Date().toISOString();

    try {
      await db.insert(schema.deploymentReleases).values({
        id,
        environmentId: envId,
        manifest: JSON.stringify(manifest),
        version: nextVersion,
        status: 'created',
        createdBy: userId,
        createdAt: now,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        throw errors.conflict(
          `Version ${nextVersion} already exists for this environment. Please retry.`,
        );
      }
      throw err;
    }

    // Trigger deployment node provisioning if the environment has no node yet.
    // This is the provisioning trigger: first release → provision node.
    const envRow = await db
      .select({ nodeId: schema.deploymentEnvironments.nodeId })
      .from(schema.deploymentEnvironments)
      .where(eq(schema.deploymentEnvironments.id, envId))
      .limit(1);

    let nodeId: string | null = envRow[0]?.nodeId ?? null;

    if (!nodeId) {
      try {
        const result = await provisionDeploymentNode(envId, projectId, userId, c.env);
        if (result) {
          nodeId = result.nodeId;
          // Keep the Worker alive while the VM provisions
          try {
            c.executionCtx.waitUntil(result.provisioningPromise);
          } catch {
            // No execution context in tests
          }
        }
      } catch (err) {
        // Provisioning failure is non-blocking — the release is still created.
        // The user can retry by submitting another release.
        log.error('deployment_release.provisioning_trigger_failed', {
          envId,
          releaseId: id,
          ...serializeError(err),
        });
      }
    }

    return c.json(
      {
        id,
        environmentId: envId,
        version: nextVersion,
        status: 'created',
        createdBy: userId,
        createdAt: now,
        nodeId,
      },
      201,
    );
  },
);

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
    await requireOwnedProject(db, projectId, userId);
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
    await requireOwnedProject(db, projectId, userId);
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
    await requireOwnedProject(db, projectId, userId);
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
