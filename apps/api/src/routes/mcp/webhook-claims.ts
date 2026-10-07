/** Shell-only credential redemption using existing MCP auth, never session cookies. */
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { errors } from '../../middleware/error';
import { redeemWebhookClaim } from '../../services/webhook-credential-claim';
import { areWebhookTriggersEnabled } from '../../services/webhook-trigger-config';
import { requireProjectTaskWrite } from '../task-project-auth';
import { authenticateMcpRequest, checkMcpRateLimit } from './_helpers';

export const webhookClaimRoutes = new Hono<{ Bindings: Env }>();
webhookClaimRoutes.post('/webhook-claims/:claimId', async (c) => {
  c.header('Cache-Control', 'private, no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  const [token] = await authenticateMcpRequest(c.req.header('Authorization'), c.env.KV, c.env);
  if (!token) throw errors.unauthorized('Invalid or expired MCP token');
  const rate = await checkMcpRateLimit(
    c.env.KV,
    token.taskId || token.agentSessionId || token.workspaceId,
    c.env
  );
  if (!rate.allowed) {
    c.header('Retry-After', String(rate.retryAfter));
    throw errors.tooManyRequests();
  }
  if (!areWebhookTriggersEnabled(c.env)) throw errors.notFound('Webhook claim');
  await requireProjectTaskWrite(drizzle(c.env.DATABASE, { schema }), token.projectId, token.userId);
  const secret = await redeemWebhookClaim(c.env, c.req.param('claimId'), token);
  if (!secret) throw errors.notFound('Webhook claim');
  return c.text(secret);
});
