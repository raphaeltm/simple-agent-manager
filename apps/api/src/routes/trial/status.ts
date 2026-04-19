/**
 * GET /api/trial/status — public availability snapshot (no auth).
 *
 * Returns:
 *   - `enabled`: kill-switch state (fail-closed on KV error)
 *   - `remaining`: cap - current count for the UTC month (0 when at/over cap)
 *   - `resetsAt`: ISO date of the next UTC month's first day
 *
 * Callers: the unauthenticated landing page and the "join waitlist" CTA.
 */
import type { TrialStatusResponse } from '@simple-agent-manager/shared';
import { Hono } from 'hono';

import type { TrialCounterState } from '../../durable-objects/trial-counter';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  currentMonthKey,
  getTrialCounterStub,
  nextMonthResetDate,
  resolveMonthlyCap,
} from '../../services/trial/helpers';
import { isTrialsEnabled } from '../../services/trial/kill-switch';

const statusRoutes = new Hono<{ Bindings: Env }>();

statusRoutes.get('/status', async (c) => {
  const env = c.env;
  const now = Date.now();
  const enabled = await isTrialsEnabled(env, now);
  const cap = resolveMonthlyCap(env);
  const monthKey = currentMonthKey(now);
  const resetsAt = nextMonthResetDate(now);

  let count = 0;
  try {
    const stub = getTrialCounterStub(env);
    const state: TrialCounterState = await (
      stub as unknown as { get(monthKey: string): Promise<TrialCounterState> }
    ).get(monthKey);
    count = state.count;
  } catch (err) {
    // DO unreachable -> surface enabled=false with zero remaining so the
    // client falls through to the waitlist CTA. This mirrors the fail-closed
    // posture of the kill-switch.
    log.error('trial.status.counter_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    const resp: TrialStatusResponse = {
      enabled: false,
      remaining: 0,
      resetsAt,
    };
    return c.json(resp, 200);
  }

  const remaining = cap > 0 ? Math.max(0, cap - count) : Number.MAX_SAFE_INTEGER;

  const resp: TrialStatusResponse = {
    enabled,
    remaining,
    resetsAt,
  };
  return c.json(resp, 200);
});

export { statusRoutes };
