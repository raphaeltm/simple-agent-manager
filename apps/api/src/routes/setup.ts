import { type AgentEmailSetupPlan, SYSTEM_USER_ID } from '@simple-agent-manager/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import * as v from 'valibot';

import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import { expectJsonRecord, maybeJsonRecord } from '../lib/runtime-validation';
import { AppError, errors } from '../middleware/error';
import { parseOptionalBody } from '../schemas/_validator';
import { planAgentEmailSetup, runAgentEmailSetup } from '../services/agent-email/setup';
import { bootstrapOwnerEmail } from '../services/bootstrap-owner';
import { emailSignUpOffered } from '../services/email-sign-in';
import {
  completeSetupWithConfig,
  getPlatformConfigStatus,
  isSetupCompleted,
  isSetupTokenConfigured,
  type PlatformIntegrationInput,
  previewPlatformIntegrationConfig,
  verifySetupToken,
} from '../services/platform-config';
import {
  validatePlatformIntegrationInput,
  validateSetupCanComplete,
} from '../services/platform-config-validation';

const log = createModuleLogger('setup');
const setupRoutes = new Hono<{ Bindings: Env }>();
type SetupContext = Context<{ Bindings: Env }>;

// `token`/`config` are validated loosely here (presence + object shape only) —
// parseSetupBody/parseIntegrationConfig below remain the authoritative,
// message-producing validators, matching the existing behavior for
// malformed/null/non-object bodies.
const SetupRequestBodySchema = v.object({
  token: v.optional(v.unknown()),
  config: v.optional(v.unknown()),
  // Present when the owner keeps agent email on; carries the previewed plan's consent token.
  agentEmail: v.optional(v.object({ consentToken: v.optional(v.nullable(v.string())) })),
});

function clientIdentifier(c: SetupContext): string {
  return (
    c.req.header('CF-Connecting-IP') ??
    c.req.header('X-Forwarded-For') ??
    c.req.header('User-Agent') ??
    'unknown'
  );
}

function setupClosed(): AppError {
  return new AppError(410, 'SETUP_CLOSED', 'First-run setup has already been completed');
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseIntegrationConfig(value: unknown): PlatformIntegrationInput {
  if (value === undefined) return {};
  let record: Record<string, unknown>;
  try {
    record = expectJsonRecord(value, 'setup.config');
  } catch {
    throw errors.badRequest('config must be an object');
  }

  const github = maybeJsonRecord(record.github) ?? {};
  const google = maybeJsonRecord(record.google) ?? {};
  const gitlab = maybeJsonRecord(record.gitlab) ?? {};
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
  agentEmail: { consentToken: string | null } | null;
}> {
  const body = await parseOptionalBody(c.req.raw, SetupRequestBodySchema, {});
  if (typeof body.token !== 'string') {
    throw errors.badRequest('Setup token is required');
  }
  return {
    token: body.token,
    config: parseIntegrationConfig(body.config),
    agentEmail: body.agentEmail ? { consentToken: body.agentEmail.consentToken ?? null } : null,
  };
}

/** What the first-run screens need beyond the integration status. Token-gated by the callers. */
async function signInSummary(env: Env) {
  return {
    email: emailSignUpOffered(env),
    ownerEmail: bootstrapOwnerEmail(env) || null,
  };
}

/** The agent email plan, or null when it cannot be read; setup never fails because of it. */
async function agentEmailPlan(env: Env): Promise<AgentEmailSetupPlan | null> {
  try {
    return await planAgentEmailSetup(env);
  } catch (error) {
    log.warn('setup.agent_email_plan_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function assertSetupOpen(env: Env): Promise<void> {
  if (await isSetupCompleted(env)) {
    throw setupClosed();
  }
}

async function assertSetupToken(env: Env, token: string, identifier: string): Promise<void> {
  const result = await verifySetupToken(env, token, identifier);
  if (!result.ok) {
    throw new AppError(
      result.status,
      result.status === 429 ? 'TOO_MANY_REQUESTS' : 'UNAUTHORIZED',
      result.message
    );
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
  const [status, signIn, agentEmail] = await Promise.all([
    getPlatformConfigStatus(c.env),
    signInSummary(c.env),
    agentEmailPlan(c.env),
  ]);
  return c.json({ ok: true, status, signIn, agentEmail });
});

setupRoutes.post('/complete', async (c) => {
  await assertSetupOpen(c.env);
  const { token, config, agentEmail } = await parseSetupBody(c);
  await assertSetupToken(c.env, token, clientIdentifier(c));

  const validation = await validatePlatformIntegrationInput(c.env, config);
  if (!validation.ok) {
    throw errors.badRequest('Platform configuration is invalid', { errors: validation.errors });
  }

  const preview = await previewPlatformIntegrationConfig(c.env, config);
  const completion = validateSetupCanComplete(preview, {
    emailSignIn: emailSignUpOffered(c.env),
  });
  if (!completion.ok) {
    throw errors.badRequest('Setup cannot be completed', { errors: completion.errors });
  }
  await completeSetupWithConfig(c.env, config);
  return c.json({
    completed: true,
    status: await getPlatformConfigStatus(c.env),
    agentEmail: agentEmail ? await turnOnAgentEmail(c.env, agentEmail.consentToken) : null,
  });
});

/**
 * Turns agent email on as the last step of setup, with the consent token of the plan the owner
 * previewed. Setup is already complete by then, so a failure is reported, not thrown: the owner
 * can retry from Admin → Integrations → Agent email.
 */
async function turnOnAgentEmail(
  env: Env,
  consentToken: string | null
): Promise<{ plan: AgentEmailSetupPlan | null; error: string | null }> {
  try {
    const plan = await runAgentEmailSetup(env, { consentToken, userId: SYSTEM_USER_ID });
    return { plan, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('setup.agent_email_failed', { error: message });
    return { plan: null, error: message };
  }
}

export { setupRoutes };
