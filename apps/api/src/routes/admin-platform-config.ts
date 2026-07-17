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

adminPlatformConfigRoutes.get('/', async (c) => {
  return c.json({ status: await getPlatformConfigStatus(c.env) });
});

adminPlatformConfigRoutes.put(
  '/',
  jsonValidator(UpdatePlatformIntegrationConfigSchema),
  async (c) => {
    const { config } = c.req.valid('json');
    if (config.googleInfrastructure) {
      await enforceCredentialMutationRateLimit(
        c.env,
        getUserId(c),
        'google-infra-oauth',
      );
    }
    const validation = await validatePlatformIntegrationInput(c.env, config);
    if (!validation.ok) {
      throw errors.badRequest('Platform configuration is invalid', { errors: validation.errors });
    }
    await savePlatformIntegrationConfig(c.env, config, getUserId(c));
    return c.json({ status: await getPlatformConfigStatus(c.env) });
  },
);

export { adminPlatformConfigRoutes };
