import type { UpsertDeploymentEnvironmentConfigVarRequest } from '@simple-agent-manager/shared';
import { and, count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import { rateLimitCredentialUpdate } from '../middleware/rate-limit';
import {
  buildDeploymentEnvironmentConfigResponse,
  deleteDeploymentEnvironmentConfigVar,
  loadDeploymentEnvironmentConfigRows,
  upsertDeploymentEnvironmentConfigVar,
} from '../services/deployment-environment-config';
import { getRuntimeLimits } from '../services/limits';
import { byteLength, PROJECT_ENV_KEY_PATTERN } from './projects/_helpers';

const deploymentEnvironmentConfigRoutes = new Hono<{ Bindings: Env }>();

async function requireOwnedEnvironment(
  db: ReturnType<typeof drizzle<typeof schema>>,
  envId: string,
  projectId: string
): Promise<schema.DeploymentEnvironmentRow> {
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

  const environment = rows[0];
  if (!environment) {
    throw errors.notFound('Deployment environment');
  }
  return environment;
}

function parseConfigRequest(body: unknown): UpsertDeploymentEnvironmentConfigVarRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw errors.badRequest('JSON body is required');
  }
  const rec = body as Record<string, unknown>;
  return {
    key: typeof rec.key === 'string' ? rec.key : '',
    value: typeof rec.value === 'string' ? rec.value : '',
    isSecret: Boolean(rec.isSecret),
  };
}

deploymentEnvironmentConfigRoutes.get(
  '/:projectId/environments/:envId/runtime-config',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'secret:read');
    await requireOwnedEnvironment(db, envId, projectId);

    return c.json(await buildDeploymentEnvironmentConfigResponse(db, envId));
  }
);

deploymentEnvironmentConfigRoutes.post(
  '/:projectId/environments/:envId/runtime/env-vars',
  requireAuth(),
  requireApproved(),
  (c, next) => rateLimitCredentialUpdate(c.env)(c, next),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    const body = parseConfigRequest(await c.req.json());
    const limits = getRuntimeLimits(c.env);

    await requireProjectCapability(db, projectId, userId, 'secret:write');
    await requireOwnedEnvironment(db, envId, projectId);

    const envKey = body.key.trim();
    if (!envKey || !PROJECT_ENV_KEY_PATTERN.test(envKey)) {
      throw errors.badRequest('key must match [A-Za-z_][A-Za-z0-9_]*');
    }
    if (body.isSecret && body.value.length === 0) {
      throw errors.badRequest('secret value must not be empty');
    }
    if (byteLength(body.value) > limits.maxDeploymentEnvValueBytes) {
      throw errors.badRequest(
        `value exceeds max size of ${limits.maxDeploymentEnvValueBytes} bytes`
      );
    }

    const existingRows = await db
      .select({ id: schema.deploymentEnvironmentConfigVars.id })
      .from(schema.deploymentEnvironmentConfigVars)
      .where(
        and(
          eq(schema.deploymentEnvironmentConfigVars.environmentId, envId),
          eq(schema.deploymentEnvironmentConfigVars.envKey, envKey)
        )
      )
      .limit(1);

    if (!existingRows[0]) {
      const countRows = await db
        .select({ count: count() })
        .from(schema.deploymentEnvironmentConfigVars)
        .where(eq(schema.deploymentEnvironmentConfigVars.environmentId, envId));
      if ((countRows[0]?.count ?? 0) >= limits.maxDeploymentEnvVarsPerEnvironment) {
        throw errors.badRequest(
          `Maximum ${limits.maxDeploymentEnvVarsPerEnvironment} deployment config vars allowed per environment`
        );
      }
    }

    const currentRows = await loadDeploymentEnvironmentConfigRows(db, envId);
    const existingTotalBytes = currentRows
      .filter((row) => row.envKey !== envKey)
      .reduce((sum, row) => sum + byteLength(`${row.envKey}=${row.storedValue}`) + 1, 0);
    const nextTotalBytes = existingTotalBytes + byteLength(`${envKey}=${body.value}`) + 1;
    if (nextTotalBytes > limits.maxDeploymentEnvTotalBytes) {
      throw errors.badRequest(
        `deployment config exceeds max aggregate size of ${limits.maxDeploymentEnvTotalBytes} bytes`
      );
    }

    await upsertDeploymentEnvironmentConfigVar(db, {
      environmentId: envId,
      envKey,
      value: body.value,
      isSecret: Boolean(body.isSecret),
      encryptionKey: getCredentialEncryptionKey(c.env),
    });

    return c.json(await buildDeploymentEnvironmentConfigResponse(db, envId));
  }
);

deploymentEnvironmentConfigRoutes.delete(
  '/:projectId/environments/:envId/runtime/env-vars/:envKey',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const envKey = c.req.param('envKey')?.trim();
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });

    if (!envKey || !PROJECT_ENV_KEY_PATTERN.test(envKey)) {
      throw errors.badRequest('envKey must match [A-Za-z_][A-Za-z0-9_]*');
    }

    await requireProjectCapability(db, projectId, userId, 'secret:write');
    await requireOwnedEnvironment(db, envId, projectId);
    await deleteDeploymentEnvironmentConfigVar(db, envId, envKey);

    return c.json(await buildDeploymentEnvironmentConfigResponse(db, envId));
  }
);

export { deploymentEnvironmentConfigRoutes };
