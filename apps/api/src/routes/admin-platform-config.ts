import { Hono } from 'hono';

import type { Env } from '../env';
import { getUserId, requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import { jsonValidator, UpdatePlatformIntegrationConfigSchema } from '../schemas';
import { enforceCredentialMutationRateLimit } from '../services/credential-mutation-rate-limit';
import {
  getPlatformConfigStatus,
  savePlatformIntegrationConfig,
} from '../services/platform-config';
import { validatePlatformIntegrationInput } from '../services/platform-config-validation';

const adminPlatformConfigRoutes = new Hono<{ Bindings: Env }>();

adminPlatformConfigRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

async function assertFeedbackProjectSelection(
  env: Env,
  userId: string,
  projectId: string
): Promise<void> {
  const row = await env.DATABASE.prepare(
    `SELECT p.id
     FROM projects p
     INNER JOIN project_members pm ON pm.project_id = p.id
     WHERE p.id = ? AND pm.user_id = ? AND pm.status = 'active'
     LIMIT 1`
  )
    .bind(projectId, userId)
    .first<{ id: string }>();
  if (!row) {
    throw errors.badRequest('Feedback project must exist and be a project you can access');
  }
}

adminPlatformConfigRoutes.get('/', async (c) => {
  return c.json({ status: await getPlatformConfigStatus(c.env, { userId: getUserId(c) }) });
});

adminPlatformConfigRoutes.put(
  '/',
  jsonValidator(UpdatePlatformIntegrationConfigSchema),
  async (c) => {
    const { config } = c.req.valid('json');
    const userId = getUserId(c);
    if (config.googleInfrastructure) {
      await enforceCredentialMutationRateLimit(c.env, userId, 'google-infra-oauth');
    }
    if (config.feedback?.remove && config.feedback.projectId?.trim()) {
      throw errors.badRequest('Choose a feedback project or clear the runtime selection, not both');
    }
    const feedbackProjectId = config.feedback?.projectId?.trim();
    if (feedbackProjectId) {
      await assertFeedbackProjectSelection(c.env, userId, feedbackProjectId);
    }
    const validation = await validatePlatformIntegrationInput(c.env, config);
    if (!validation.ok) {
      throw errors.badRequest('Platform configuration is invalid', { errors: validation.errors });
    }
    await savePlatformIntegrationConfig(c.env, config, userId);
    return c.json({ status: await getPlatformConfigStatus(c.env, { userId }) });
  }
);

export { adminPlatformConfigRoutes };
