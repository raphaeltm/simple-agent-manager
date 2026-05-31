import { drizzle } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';

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
  buildSkillRuntimeConfigResponse,
  deleteSkillRuntimeEnvVar,
  deleteSkillRuntimeFile,
  requireOwnedProjectScopedSkill,
  upsertSkillRuntimeEnvVar,
  upsertSkillRuntimeFile,
} from '../services/profile-runtime-assets';
import { byteLength, normalizeProjectFilePath, PROJECT_ENV_KEY_PATTERN } from './projects/_helpers';

export const skillRuntimeRoutes = new Hono<{ Bindings: Env }>();

skillRuntimeRoutes.use('/*', requireAuth(), requireApproved());

skillRuntimeRoutes.get('/env-vars', async (c) => {
  const { db, skillId, userId } = await requireSkillRuntimeAccess(c);
  const response = await buildSkillRuntimeConfigResponse(db, skillId, userId);
  return c.json({ envVars: response.envVars });
});

skillRuntimeRoutes.post('/env-vars', jsonValidator(UpsertProjectRuntimeEnvVarSchema), async (c) => {
  const body = c.req.valid('json');
  const limits = getRuntimeLimits(c.env);
  const { db, skillId, userId } = await requireSkillRuntimeAccess(c);
  const envKey = body.key.trim();
  if (!PROJECT_ENV_KEY_PATTERN.test(envKey)) throw errors.badRequest('key must match [A-Za-z_][A-Za-z0-9_]*');
  if (byteLength(body.value) > limits.maxProjectRuntimeEnvValueBytes) {
    throw errors.badRequest(`value exceeds max size of ${limits.maxProjectRuntimeEnvValueBytes} bytes`);
  }
  await upsertSkillRuntimeEnvVar(db, {
    skillId,
    userId,
    envKey,
    value: body.value,
    isSecret: Boolean(body.isSecret),
    maxCount: limits.maxProjectRuntimeEnvVarsPerProject,
    encryptionKey: getCredentialEncryptionKey(c.env),
  });
  return c.json(await buildSkillRuntimeConfigResponse(db, skillId, userId));
});

skillRuntimeRoutes.delete('/env-vars/:envKey', async (c) => {
  const envKey = requireRouteParam(c, 'envKey').trim();
  if (!PROJECT_ENV_KEY_PATTERN.test(envKey)) throw errors.badRequest('envKey must match [A-Za-z_][A-Za-z0-9_]*');
  const { db, skillId, userId } = await requireSkillRuntimeAccess(c);
  await deleteSkillRuntimeEnvVar(db, skillId, userId, envKey);
  return c.json(await buildSkillRuntimeConfigResponse(db, skillId, userId));
});

skillRuntimeRoutes.get('/files', async (c) => {
  const { db, skillId, userId } = await requireSkillRuntimeAccess(c);
  const response = await buildSkillRuntimeConfigResponse(db, skillId, userId);
  return c.json({ files: response.files });
});

skillRuntimeRoutes.post('/files', jsonValidator(UpsertProjectRuntimeFileSchema), async (c) => {
  const body = c.req.valid('json');
  const limits = getRuntimeLimits(c.env);
  const { db, skillId, userId } = await requireSkillRuntimeAccess(c);
  const path = normalizeProjectFilePath(body.path);
  if (path.length > limits.maxProjectRuntimeFilePathLength) {
    throw errors.badRequest(`path exceeds max length of ${limits.maxProjectRuntimeFilePathLength} characters`);
  }
  if (byteLength(body.content) > limits.maxProjectRuntimeFileContentBytes) {
    throw errors.badRequest(`content exceeds max size of ${limits.maxProjectRuntimeFileContentBytes} bytes`);
  }
  await upsertSkillRuntimeFile(db, {
    skillId,
    userId,
    path,
    content: body.content,
    isSecret: Boolean(body.isSecret),
    maxCount: limits.maxProjectRuntimeFilesPerProject,
    encryptionKey: getCredentialEncryptionKey(c.env),
  });
  return c.json(await buildSkillRuntimeConfigResponse(db, skillId, userId));
});

skillRuntimeRoutes.delete('/files/*', async (c) => {
  const rawPath = c.req.param('*') || c.req.query('path');
  if (!rawPath) throw errors.badRequest('file path is required');
  const path = normalizeProjectFilePath(rawPath);
  const { db, skillId, userId } = await requireSkillRuntimeAccess(c);
  await deleteSkillRuntimeFile(db, skillId, userId, path);
  return c.json(await buildSkillRuntimeConfigResponse(db, skillId, userId));
});

async function requireSkillRuntimeAccess(c: Context<{ Bindings: Env }>) {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const skillId = requireRouteParam(c, 'skillId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, userId);
  await requireOwnedProjectScopedSkill(db, projectId, skillId, userId);
  return { db, skillId, userId };
}
