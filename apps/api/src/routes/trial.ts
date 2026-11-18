import { drizzle } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { getTrialStatus } from '../services/platform-trial';

const trialRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/trial-status — authenticated current-user platform compute eligibility.
 *
 * Returns whether the user can use installation-provided infrastructure and AI
 * (an enabled platform cloud credential plus the AI proxy) without bringing their
 * own credentials, plus their current daily AI token budget and usage when the
 * platform path is available. The path name predates the retirement of the
 * anonymous-trial product and is kept for client compatibility.
 */
trialRoutes.get('/trial-status', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  try {
    const status = await getTrialStatus(db, userId, c.env);
    return c.json(status);
  } catch (err) {
    // Platform availability is non-critical — return unavailable rather than 500
    log.error('trial_status.error', { error: err instanceof Error ? err.message : String(err) });
    return c.json({
      available: false,
      agentType: null,
      hasInfraCredential: false,
      hasAgentCredential: false,
      dailyTokenBudget: null,
      dailyTokenUsage: null,
    });
  }
});

/**
 * `/api/trial/*` — the retired anonymous-trial endpoints (create, claim, status, waitlist,
 * events). Closed for every method so stale links and old clients get an explicit answer
 * instead of a generic 404, and so nothing on this path can reach D1, KV or a Durable Object.
 */
function retiredTrialResponse(c: Context<{ Bindings: Env }>) {
  return c.json(
    {
      error: 'GONE',
      message:
        'Anonymous trials have been retired. SAM is self-hosted: deploy your own instance with the self-hosting guide.',
    },
    410
  );
}
trialRoutes.all('/trial', retiredTrialResponse);
trialRoutes.all('/trial/*', retiredTrialResponse);

export { trialRoutes };
