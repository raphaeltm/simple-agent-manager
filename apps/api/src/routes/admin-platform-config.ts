import { Hono } from 'hono';

import type { Env } from '../env';
import { getUserId, requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  getPlatformConfigStatus,
  type PlatformIntegrationInput,
  savePlatformIntegrationConfig,
} from '../services/platform-config';
import { validatePlatformIntegrationInput } from '../services/platform-config-validation';

const adminPlatformConfigRoutes = new Hono<{ Bindings: Env }>();

adminPlatformConfigRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseConfig(value: unknown): PlatformIntegrationInput {
  if (!isRecord(value)) {
    throw errors.badRequest('config must be an object');
  }
  const github = isRecord(value.github) ? value.github : {};
  const google = isRecord(value.google) ? value.google : {};
  const gitlab = isRecord(value.gitlab) ? value.gitlab : {};
  return {
    github: {
      clientId: optionalString(github.clientId),
      clientSecret: optionalString(github.clientSecret),
      appId: optionalString(github.appId),
      appPrivateKey: optionalString(github.appPrivateKey),
      appSlug: optionalString(github.appSlug),
      webhookSecret: optionalString(github.webhookSecret),
    },
    google: {
      clientId: optionalString(google.clientId),
      clientSecret: optionalString(google.clientSecret),
    },
    gitlab: {
      host: optionalString(gitlab.host),
      clientId: optionalString(gitlab.clientId),
      clientSecret: optionalString(gitlab.clientSecret),
    },
  };
}

adminPlatformConfigRoutes.get('/', async (c) => {
  return c.json({ status: await getPlatformConfigStatus(c.env) });
});

adminPlatformConfigRoutes.put('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  const config = parseConfig(isRecord(body) ? body.config : null);
  const validation = await validatePlatformIntegrationInput(c.env, config);
  if (!validation.ok) {
    throw errors.badRequest('Platform configuration is invalid', { errors: validation.errors });
  }
  await savePlatformIntegrationConfig(c.env, config, getUserId(c));
  return c.json({ status: await getPlatformConfigStatus(c.env) });
});

export { adminPlatformConfigRoutes };
