/**
 * Superadmin agent email status, setup and loopback self-test (preview).
 *
 * - The setup (`/setup`) turns agent email on after the deploy prepared it; see
 *   `services/agent-email/setup.ts`.
 * - The loopback sends one fixed message from `agent+loopback@agents.<BASE_DOMAIN>` to an
 *   existing email trigger, so an operator can prove routing and sending end to end without a
 *   personal mailbox.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getAuth, requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { AppError, errors } from '../middleware/error';
import {
  checkRateLimit,
  createRateLimitKey,
  DEFAULT_WINDOW_SECONDS,
  getCurrentWindowStart,
} from '../middleware/rate-limit';
import { jsonValidator } from '../schemas';
import { agentEmailAddress, parseAgentEmailRecipient } from '../services/agent-email/address';
import { CloudflareEmailApiError } from '../services/agent-email/cloudflare-email-api';
import { readLoopbackStatus, sendLoopbackTest } from '../services/agent-email/loopback';
import { DEFAULT_AGENT_EMAIL_READ_TIMEOUT_MS } from '../services/agent-email/setting-definitions';
import { getAgentEmailLimits } from '../services/agent-email/settings';
import { planAgentEmailSetup, runAgentEmailSetup } from '../services/agent-email/setup';
import {
  AgentEmailMainDomainChangedError,
  AgentEmailSetupRefusedError,
} from '../services/agent-email/setup-errors';
import { activeAgentEmailSender, agentEmailConfig } from '../services/agent-email/setup-state';
import { IoTimeoutError, withDeadline } from '../services/fetch-timeout';

const LoopbackSchema = v.object({
  to: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.maxLength(254)),
});

const SetupSchema = v.object({
  // The plan's consentToken (a SHA-256 hex digest) when the plan lists changes.
  consentToken: v.optional(v.pipe(v.string(), v.maxLength(128))),
});

const adminAgentEmailRoutes = new Hono<{ Bindings: Env }>();

// Read-only deadlines include auth/config middleware: production's 113843ms canceled
// request was GET /agent-email (status), whose handler makes no external HTTP calls.
adminAgentEmailRoutes.use('/*', async (c, next) => {
  if (c.req.method !== 'GET') return next();
  const limits = await withDeadline(
    () => getAgentEmailLimits(c.env),
    DEFAULT_AGENT_EMAIL_READ_TIMEOUT_MS
  );
  const timeoutMs = c.req.path.endsWith('/setup')
    ? limits.setupPlanTimeoutMs
    : limits.readTimeoutMs;
  await withDeadline(() => next(), timeoutMs, c.req.raw.signal).catch((error: unknown) => {
    if (error instanceof IoTimeoutError)
      throw new AppError(
        504,
        'AGENT_EMAIL_TIMEOUT',
        'Agent email verification timed out. Try again.'
      );
    throw error;
  });
});
adminAgentEmailRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

adminAgentEmailRoutes.get('/', async (c) => {
  const limits = await withDeadline(
    () => getAgentEmailLimits(c.env),
    DEFAULT_AGENT_EMAIL_READ_TIMEOUT_MS
  );
  const [config, loopback] = await withDeadline(
    () => Promise.all([agentEmailConfig(c.env), readLoopbackStatus(c.env)]),
    limits.readTimeoutMs,
    c.req.raw.signal
  );
  return c.json({ ...config, loopback });
});

/** The setup's own refusals are conflicts; a failed Cloudflare call is an upstream error. */
function setupError(error: unknown): unknown {
  if (error instanceof AgentEmailSetupRefusedError) return errors.conflict(error.message);
  if (error instanceof AgentEmailMainDomainChangedError) return errors.conflict(error.message);
  if (error instanceof CloudflareEmailApiError) {
    return new AppError(502, 'CLOUDFLARE_ERROR', error.message);
  }
  return error;
}

/** What the setup would do now, including the main-domain records it would let Cloudflare add. */
adminAgentEmailRoutes.get('/setup', async (c) => {
  try {
    return c.json(await planAgentEmailSetup(c.env));
  } catch (error) {
    throw setupError(error);
  }
});

adminAgentEmailRoutes.post('/setup', jsonValidator(SetupSchema), async (c) => {
  // One-hour window, matching the agentEmail.setupRunsPerHour setting.
  const { setupRunsPerHour } = await getAgentEmailLimits(c.env);
  const rate = await checkRateLimit(
    c.env.KV,
    createRateLimitKey(
      'agent-email-setup',
      getAuth(c).user.id,
      getCurrentWindowStart(DEFAULT_WINDOW_SECONDS)
    ),
    setupRunsPerHour,
    DEFAULT_WINDOW_SECONDS
  );
  if (!rate.allowed) throw errors.tooManyRequests('Setup run limit reached; try again later');
  try {
    const plan = await runAgentEmailSetup(c.env, {
      consentToken: c.req.valid('json').consentToken ?? null,
      userId: getAuth(c).user.id,
    });
    return c.json(plan);
  } catch (error) {
    throw setupError(error);
  }
});

adminAgentEmailRoutes.post('/loopback', jsonValidator(LoopbackSchema), async (c) => {
  const sender = await activeAgentEmailSender(c.env);
  if (!sender) throw errors.conflict('Agent email is not enabled on this deployment');
  const recipient = parseAgentEmailRecipient(c.req.valid('json').to, c.env.BASE_DOMAIN);
  if (recipient?.kind !== 'trigger') {
    throw errors.badRequest(
      'Send the loopback test to an email trigger address on this deployment'
    );
  }
  const db = drizzle(c.env.DATABASE, { schema });
  const trigger = await db
    .select({ triggerId: schema.triggerEmailConfigs.triggerId })
    .from(schema.triggerEmailConfigs)
    .where(eq(schema.triggerEmailConfigs.addressKey, recipient.key))
    .get();
  if (!trigger) throw errors.notFound('Email trigger');

  // One-hour window, matching the agentEmail.loopbackPerHour setting.
  const { loopbackPerHour } = await getAgentEmailLimits(c.env);
  const rate = await checkRateLimit(
    c.env.KV,
    createRateLimitKey(
      'agent-email-loopback',
      getAuth(c).user.id,
      getCurrentWindowStart(DEFAULT_WINDOW_SECONDS)
    ),
    loopbackPerHour,
    DEFAULT_WINDOW_SECONDS
  );
  if (!rate.allowed) throw errors.tooManyRequests('Loopback test limit reached; try again later');

  const sent = await sendLoopbackTest(
    c.env,
    sender,
    agentEmailAddress(c.env.BASE_DOMAIN, recipient.key),
    new Date()
  );
  return c.json(sent, 202);
});

export { adminAgentEmailRoutes };
