/**
 * Deployment volume routes.
 *
 * CRUD + attach/detach for environment-scoped provider block volumes.
 * All provider operations go through the shared Provider interface.
 *
 * Scoped under /api/projects/:projectId/environments/:envId/volumes.
 * Auth: session cookie + project ownership.
 */

import { type CredentialProvider, isValidProvider } from '@simple-agent-manager/shared';
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
  attachEnvironmentVolumesToLinkedNode,
  createEnvironmentVolume,
  deleteEnvironmentVolume,
  detachEnvironmentVolumesFromLinkedNode,
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
    v.regex(VOLUME_NAME_RE, 'Name must be lowercase alphanumeric with optional hyphens, 1-63 chars')
  ),
  sizeGb: v.pipe(
    v.number('sizeGb is required'),
    v.integer('sizeGb must be an integer'),
    v.minValue(1, 'sizeGb must be at least 1')
  ),
  location: v.pipe(v.string('location is required'), v.minLength(1, 'location must not be empty')),
});

// =============================================================================
// Helpers
// =============================================================================

async function requireOwnedEnvironment(
  db: ReturnType<typeof drizzle>,
  envId: string,
  projectId: string
) {
  const rows = await db
    .select()
    .from(schema.deploymentEnvironments)
    .where(
      and(
        eq(schema.deploymentEnvironments.id, envId),
        eq(schema.deploymentEnvironments.projectId, projectId)
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw errors.notFound('Deployment environment');
  }
  return row;
}

function toCredentialProvider(value: unknown): CredentialProvider | undefined {
  return typeof value === 'string' && isValidProvider(value) ? value : undefined;
}

async function resolveManualVolumeCreateProvider(
  db: ReturnType<typeof drizzle>,
  envRow: Awaited<ReturnType<typeof requireOwnedEnvironment>>,
  requestedLocation: string
): Promise<CredentialProvider | undefined> {
  const existingVolumes = await listEnvironmentVolumes(db, envRow.id);
  const firstVolume = existingVolumes[0];

  if (firstVolume) {
    const provider = toCredentialProvider(firstVolume.providerName);
    if (!provider) {
      throw new Error(`Existing volume provider "${firstVolume.providerName}" is not supported`);
    }

    for (const volume of existingVolumes) {
      if (volume.providerName !== firstVolume.providerName) {
        throw new Error('Existing environment volumes use mixed providers; resolve them before adding more');
      }
      if (volume.location !== requestedLocation) {
        throw new Error(
          `New volume location "${requestedLocation}" must match existing environment volume location "${volume.location}"`
        );
      }
    }
    return provider;
  }

  if (envRow.location && envRow.location !== requestedLocation) {
    throw new Error(
      `New volume location "${requestedLocation}" must match environment location "${envRow.location}"`
    );
  }

  return toCredentialProvider(envRow.provider);
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
    const envRow = await requireOwnedEnvironment(db, envId, projectId);

    const { name, sizeGb, location } = c.req.valid('json');

    try {
      const targetProvider = await resolveManualVolumeCreateProvider(db, envRow, location);
      const createOptions: {
        environmentId: string;
        name: string;
        sizeGb: number;
        location: string;
        targetProvider?: CredentialProvider;
      } = {
        environmentId: envId,
        name,
        sizeGb,
        location,
      };
      if (targetProvider) {
        createOptions.targetProvider = targetProvider;
      }

      const volume = await createEnvironmentVolume(db, c.env, userId, {
        ...createOptions,
      });
      return c.json(volume, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Volume creation failed';
      throw errors.badRequest(message);
    }
  }
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
  }
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
  }
);

/**
 * POST /api/projects/:projectId/environments/:envId/volumes/attach
 * Attach all environment volumes to the environment's linked deployment node.
 */
deploymentVolumeRoutes.post(
  '/:projectId/environments/:envId/volumes/attach',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });

    await requireOwnedProject(db, projectId, userId);
    await requireOwnedEnvironment(db, envId, projectId);

    try {
      const volumes = await attachEnvironmentVolumesToLinkedNode(db, c.env, userId, envId);
      return c.json({ volumes });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Volume attach failed';
      throw errors.badRequest(message);
    }
  }
);

/**
 * POST /api/projects/:projectId/environments/:envId/volumes/detach
 * Detach all environment volumes from the environment's linked deployment node.
 */
deploymentVolumeRoutes.post(
  '/:projectId/environments/:envId/volumes/detach',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });

    await requireOwnedProject(db, projectId, userId);
    await requireOwnedEnvironment(db, envId, projectId);

    try {
      const volumes = await detachEnvironmentVolumesFromLinkedNode(db, c.env, userId, envId);
      return c.json({ volumes });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Volume detach failed';
      throw errors.badRequest(message);
    }
  }
);

export { deploymentVolumeRoutes };
