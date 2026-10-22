/**
 * Superadmin agent email status and loopback self-test (preview). The loopback sends one
 * fixed message from `agent+loopback@agents.<BASE_DOMAIN>` to an existing email trigger, so an
 * operator can prove routing and sending end to end without a personal mailbox.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getAuth, requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  checkRateLimit,
  createRateLimitKey,
  DEFAULT_WINDOW_SECONDS,
  getCurrentWindowStart,
} from '../middleware/rate-limit';
import { jsonValidator } from '../schemas';
import {
  agentEmailAddress,
  agentEmailConfig,
  parseAgentEmailRecipient,
} from '../services/agent-email/address';
import { readLoopbackStatus, sendLoopbackTest } from '../services/agent-email/loopback';
import { agentEmailSenderFor } from '../services/agent-email/provider';
import { getAgentEmailLimits } from '../services/agent-email/settings';

const LoopbackSchema = v.object({
  to: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.maxLength(254)),
});

const adminAgentEmailRoutes = new Hono<{ Bindings: Env }>();

adminAgentEmailRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

adminAgentEmailRoutes.get('/', async (c) =>
  c.json({ ...agentEmailConfig(c.env), loopback: await readLoopbackStatus(c.env) })
);

adminAgentEmailRoutes.post('/loopback', jsonValidator(LoopbackSchema), async (c) => {
  const sender = agentEmailSenderFor(c.env);
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
