/**
 * Deployment volume routes.
 *
 * CRUD + attach/detach for environment-scoped provider block volumes.
 * All provider operations go through the shared Provider interface.
 *
 * Scoped under /api/projects/:projectId/environments/:envId/volumes.
 * Auth: session cookie + project ownership.
 */

import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireOwnedProject } from '../middleware/project-auth';
import { jsonValidator } from '../schemas';
import {
  attachEnvironmentVolumes,
  createEnvironmentVolume,
  deleteEnvironmentVolume,
  detachEnvironmentVolumes,
  listEnvironmentVolumes,
} from '../services/deployment-volumes';

// =============================================================================
// Validation schemas
// =============================================================================

/** Volume name: lowercase alphanumeric + hyphens, 1-63 chars. */
const VOLUME_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const CreateVolumeSchema = v.object({
  name: v.pipe(
    v.string('name is required'),
    v.regex(VOLUME_NAME_RE, 'Name must be lowercase alphanumeric with optional hyphens, 1-63 chars'),
  ),
  sizeGb: v.pipe(
    v.number('sizeGb is required'),
    v.integer('sizeGb must be an integer'),
    v.minValue(1, 'sizeGb must be at least 1'),
  ),
  location: v.pipe(
    v.string('location is required'),
    v.minLength(1, 'location must not be empty'),
  ),
});

const AttachVolumesSchema = v.object({
  serverId: v.pipe(
    v.string('serverId is required'),
    v.minLength(1, 'serverId must not be empty'),
  ),
  location: v.pipe(
    v.string('location is required'),
    v.minLength(1, 'location must not be empty'),
  ),
});

const DetachVolumesSchema = v.object({
  serverId: v.pipe(
    v.string('serverId is required'),
    v.minLength(1, 'serverId must not be empty'),
  ),
});

// =============================================================================
// Helpers
// =============================================================================

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

// =============================================================================
// Routes
// =============================================================================

const deploymentVolumeRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/projects/:projectId/environments/:envId/volumes
 * Create a provider block volume for this environment.
 */
deploymentVolumeRoutes.post(
  '/:projectId/environments/:envId/volumes',
  requireAuth(),
  requireApproved(),
  jsonValidator(CreateVolumeSchema),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });

    await requireOwnedProject(db, projectId, userId);
    await requireOwnedEnvironment(db, envId, projectId);

    const { name, sizeGb, location } = c.req.valid('json');

    try {
      const volume = await createEnvironmentVolume(db, c.env, userId, {
        environmentId: envId,
        name,
        sizeGb,
        location,
      });
      return c.json(volume, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Volume creation failed';
      throw errors.badRequest(message);
    }
  },
);

/**
 * GET /api/projects/:projectId/environments/:envId/volumes
 * List volumes for an environment.
 */
deploymentVolumeRoutes.get(
  '/:projectId/environments/:envId/volumes',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });

    await requireOwnedProject(db, projectId, userId);
    await requireOwnedEnvironment(db, envId, projectId);

    const volumes = await listEnvironmentVolumes(db, envId);
    return c.json({ volumes });
  },
);

/**
 * DELETE /api/projects/:projectId/environments/:envId/volumes/:volumeId
 * Delete a detached volume (destroys the provider volume too).
 */
deploymentVolumeRoutes.delete(
  '/:projectId/environments/:envId/volumes/:volumeId',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const volumeId = c.req.param('volumeId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });

    await requireOwnedProject(db, projectId, userId);
    await requireOwnedEnvironment(db, envId, projectId);

    try {
      await deleteEnvironmentVolume(db, c.env, userId, volumeId, envId);
      return c.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Volume deletion failed';
      throw errors.badRequest(message);
    }
  },
);

/**
 * POST /api/projects/:projectId/environments/:envId/volumes/attach
 * Attach all environment volumes to a server. Co-location is validated.
 */
deploymentVolumeRoutes.post(
  '/:projectId/environments/:envId/volumes/attach',
  requireAuth(),
  requireApproved(),
  jsonValidator(AttachVolumesSchema),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });

    await requireOwnedProject(db, projectId, userId);
    await requireOwnedEnvironment(db, envId, projectId);

    const { serverId, location } = c.req.valid('json');

    try {
      const volumes = await attachEnvironmentVolumes(db, c.env, userId, envId, serverId, location);
      return c.json({ volumes });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Volume attach failed';
      throw errors.badRequest(message);
    }
  },
);

/**
 * POST /api/projects/:projectId/environments/:envId/volumes/detach
 * Detach all environment volumes from a server.
 */
deploymentVolumeRoutes.post(
  '/:projectId/environments/:envId/volumes/detach',
  requireAuth(),
  requireApproved(),
  jsonValidator(DetachVolumesSchema),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });

    await requireOwnedProject(db, projectId, userId);
    await requireOwnedEnvironment(db, envId, projectId);

    const { serverId } = c.req.valid('json');

    try {
      const volumes = await detachEnvironmentVolumes(db, c.env, userId, envId, serverId);
      return c.json({ volumes });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Volume detach failed';
      throw errors.badRequest(message);
    }
  },
);

export { deploymentVolumeRoutes };
