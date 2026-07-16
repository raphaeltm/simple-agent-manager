import type { Context } from 'hono';
import { Hono } from 'hono';

import type { Env } from '../env';
import { AppError, errors } from '../middleware/error';
import {
  completeSetupWithConfig,
  getPlatformConfigStatus,
  isSetupCompleted,
  isSetupTokenConfigured,
  type PlatformIntegrationInput,
  previewPlatformIntegrationConfig,
  savePlatformIntegrationConfig,
  verifySetupToken,
} from '../services/platform-config';
import {
  validatePlatformIntegrationInput,
  validateSetupCanComplete,
} from '../services/platform-config-validation';

const setupRoutes = new Hono<{ Bindings: Env }>();
type SetupContext = Context<{ Bindings: Env }>;

interface SetupRequestBody {
  token?: unknown;
  config?: unknown;
}

function clientIdentifier(c: SetupContext): string {
  return c.req.header('CF-Connecting-IP')
    ?? c.req.header('X-Forwarded-For')
    ?? c.req.header('User-Agent')
    ?? 'unknown';
}

function setupClosed(): AppError {
  return new AppError(410, 'SETUP_CLOSED', 'First-run setup has already been completed');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseIntegrationConfig(value: unknown): PlatformIntegrationInput {
  if (value === undefined) return {};
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

async function parseSetupBody(c: SetupContext): Promise<{
  token: string;
  config: PlatformIntegrationInput;
}> {
  const body = await c.req.json().catch(() => null) as SetupRequestBody | null;
  if (!body || typeof body.token !== 'string') {
    throw errors.badRequest('Setup token is required');
  }
  return {
    token: body.token,
    config: parseIntegrationConfig(body.config),
  };
}

async function assertSetupOpen(env: Env): Promise<void> {
  if (await isSetupCompleted(env)) {
    throw setupClosed();
  }
}

async function assertSetupToken(env: Env, token: string, identifier: string): Promise<void> {
  const result = await verifySetupToken(env, token, identifier);
  if (!result.ok) {
    throw new AppError(result.status, result.status === 429 ? 'TOO_MANY_REQUESTS' : 'UNAUTHORIZED', result.message);
  }
}

setupRoutes.get('/status', async (c) => {
  const completed = await isSetupCompleted(c.env);
  if (completed) {
    throw setupClosed();
  }
  return c.json({
    completed,
    open: !completed,
    forced: c.env.SETUP_FORCE === 'true',
    tokenConfigured: isSetupTokenConfigured(c.env),
  });
});

setupRoutes.post('/verify', async (c) => {
  await assertSetupOpen(c.env);
  const { token } = await parseSetupBody(c);
  await assertSetupToken(c.env, token, clientIdentifier(c));
  return c.json({ ok: true, status: await getPlatformConfigStatus(c.env) });
});

setupRoutes.put('/config', async (c) => {
  await assertSetupOpen(c.env);
  const { token, config } = await parseSetupBody(c);
  await assertSetupToken(c.env, token, clientIdentifier(c));

  const validation = await validatePlatformIntegrationInput(c.env, config);
  if (!validation.ok) {
    throw errors.badRequest('Platform configuration is invalid', { errors: validation.errors });
  }

  const resolved = await savePlatformIntegrationConfig(c.env, config);
  return c.json({ status: await getPlatformConfigStatus(c.env), config: resolved });
});

setupRoutes.post('/complete', async (c) => {
  await assertSetupOpen(c.env);
  const { token, config } = await parseSetupBody(c);
  await assertSetupToken(c.env, token, clientIdentifier(c));

  const validation = await validatePlatformIntegrationInput(c.env, config);
  if (!validation.ok) {
    throw errors.badRequest('Platform configuration is invalid', { errors: validation.errors });
  }

  const preview = await previewPlatformIntegrationConfig(c.env, config);
  const completion = validateSetupCanComplete(preview);
  if (!completion.ok) {
    throw errors.badRequest('Setup cannot be completed', { errors: completion.errors });
  }
  await completeSetupWithConfig(c.env, config);
  return c.json({ completed: true, status: await getPlatformConfigStatus(c.env) });
});

export { setupRoutes };
