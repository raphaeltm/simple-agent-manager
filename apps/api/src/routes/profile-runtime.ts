import { drizzle } from 'drizzle-orm/d1';
import { type Context,Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireOwnedProject } from '../middleware/project-auth';
import { jsonValidator, UpsertProjectRuntimeEnvVarSchema, UpsertProjectRuntimeFileSchema } from '../schemas';
import { getRuntimeLimits } from '../services/limits';
import {
  buildProfileRuntimeConfigResponse,
  deleteProfileRuntimeEnvVar,
  deleteProfileRuntimeFile,
  requireOwnedProjectScopedProfile,
  upsertProfileRuntimeEnvVar,
  upsertProfileRuntimeFile,
} from '../services/profile-runtime-assets';
import {
  byteLength,
  normalizeProjectFilePath,
  PROJECT_ENV_KEY_PATTERN,
} from './projects/_helpers';

export const profileRuntimeRoutes = new Hono<{ Bindings: Env }>();

profileRuntimeRoutes.use('/*', requireAuth(), requireApproved());

profileRuntimeRoutes.get('/env-vars', async (c) => {
  const { db, profileId, userId } = await requireProfileRuntimeAccess(c);
  const response = await buildProfileRuntimeConfigResponse(db, profileId, userId);
  return c.json({ envVars: response.envVars });
});

profileRuntimeRoutes.post('/env-vars', jsonValidator(UpsertProjectRuntimeEnvVarSchema), async (c) => {
  const body = c.req.valid('json');
  const limits = getRuntimeLimits(c.env);
  const { db, profileId, userId } = await requireProfileRuntimeAccess(c);
  const envKey = body.key.trim();

  if (!PROJECT_ENV_KEY_PATTERN.test(envKey)) {
    throw errors.badRequest('key must match [A-Za-z_][A-Za-z0-9_]*');
  }
  if (byteLength(body.value) > limits.maxProjectRuntimeEnvValueBytes) {
    throw errors.badRequest(
      `value exceeds max size of ${limits.maxProjectRuntimeEnvValueBytes} bytes`
    );
  }

  await upsertProfileRuntimeEnvVar(db, {
    profileId,
    userId,
    envKey,
    value: body.value,
    isSecret: Boolean(body.isSecret),
    maxCount: limits.maxProjectRuntimeEnvVarsPerProject,
    encryptionKey: getCredentialEncryptionKey(c.env),
  });

  const response = await buildProfileRuntimeConfigResponse(db, profileId, userId);
  return c.json(response);
});

profileRuntimeRoutes.delete('/env-vars/:envKey', async (c) => {
  const envKey = requireRouteParam(c, 'envKey').trim();
  if (!PROJECT_ENV_KEY_PATTERN.test(envKey)) {
    throw errors.badRequest('envKey must match [A-Za-z_][A-Za-z0-9_]*');
  }

  const { db, profileId, userId } = await requireProfileRuntimeAccess(c);
  await deleteProfileRuntimeEnvVar(db, profileId, userId, envKey);

  const response = await buildProfileRuntimeConfigResponse(db, profileId, userId);
  return c.json(response);
});

profileRuntimeRoutes.get('/files', async (c) => {
  const { db, profileId, userId } = await requireProfileRuntimeAccess(c);
  const response = await buildProfileRuntimeConfigResponse(db, profileId, userId);
  return c.json({ files: response.files });
});

profileRuntimeRoutes.post('/files', jsonValidator(UpsertProjectRuntimeFileSchema), async (c) => {
  const body = c.req.valid('json');
  const limits = getRuntimeLimits(c.env);
  const { db, profileId, userId } = await requireProfileRuntimeAccess(c);
  const path = normalizeProjectFilePath(body.path);

  if (path.length > limits.maxProjectRuntimeFilePathLength) {
    throw errors.badRequest(
      `path exceeds max length of ${limits.maxProjectRuntimeFilePathLength} characters`
    );
  }
  if (byteLength(body.content) > limits.maxProjectRuntimeFileContentBytes) {
    throw errors.badRequest(
      `content exceeds max size of ${limits.maxProjectRuntimeFileContentBytes} bytes`
    );
  }

  await upsertProfileRuntimeFile(db, {
    profileId,
    userId,
    path,
    content: body.content,
    isSecret: Boolean(body.isSecret),
    maxCount: limits.maxProjectRuntimeFilesPerProject,
    encryptionKey: getCredentialEncryptionKey(c.env),
  });

  const response = await buildProfileRuntimeConfigResponse(db, profileId, userId);
  return c.json(response);
});

profileRuntimeRoutes.delete('/files/*', async (c) => {
  const rawPath = c.req.param('*') || c.req.query('path');
  if (!rawPath) {
    throw errors.badRequest('file path is required');
  }

  const path = normalizeProjectFilePath(rawPath);
  const { db, profileId, userId } = await requireProfileRuntimeAccess(c);
  await deleteProfileRuntimeFile(db, profileId, userId, path);

  const response = await buildProfileRuntimeConfigResponse(db, profileId, userId);
  return c.json(response);
});

async function requireProfileRuntimeAccess(c: Context<{ Bindings: Env }>) {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const profileId = requireRouteParam(c, 'profileId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);
  await requireOwnedProjectScopedProfile(db, projectId, profileId, userId);

  return { db, profileId, userId };
}
