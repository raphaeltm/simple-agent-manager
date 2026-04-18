/**
 * POST /api/trial/waitlist — queue for notification when the monthly cap
 * resets.
 *
 * Public endpoint (no auth). Upserts a row into `trial_waitlist` using the
 * UNIQUE(email, reset_date) index so repeated submits within the same
 * reset window are idempotent (returned as `{ queued: true }` without
 * creating duplicates). The monthly notifier cron flips `notified_at`
 * when the window opens and an email is sent.
 */
import {
  TrialWaitlistRequestSchema,
  type TrialWaitlistResponse,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { nextMonthResetDate } from '../../services/trial/helpers';

const waitlistRoutes = new Hono<{ Bindings: Env }>();

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

waitlistRoutes.post('/waitlist', async (c) => {
  const env = c.env;
  const now = Date.now();

  // Parse + validate
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: 'BAD_REQUEST', message: 'Request body must be valid JSON' },
      400
    );
  }
  const parsed = v.safeParse(TrialWaitlistRequestSchema, body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'BAD_REQUEST',
        message: parsed.issues[0]?.message ?? 'Invalid email',
      },
      400
    );
  }

  // Normalise the email — UNIQUE index is case-sensitive by default; fold
  // to lowercase so repeated submits with different casing dedupe cleanly.
  const email = parsed.output.email.toLowerCase();
  const resetDate = nextMonthResetDate(now);

  const db = drizzle(env.DATABASE, { schema });
  try {
    await db
      .insert(schema.trialWaitlist)
      .values({
        id: randomId('wl'),
        email,
        submittedAt: now,
        resetDate,
        notifiedAt: null,
      })
      .onConflictDoNothing({
        target: [schema.trialWaitlist.email, schema.trialWaitlist.resetDate],
      });
  } catch (err) {
    log.error('trial.waitlist.insert_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to queue waitlist entry' },
      500
    );
  }

  const resp: TrialWaitlistResponse = { queued: true, resetsAt: resetDate };
  return c.json(resp, 200);
});

export { waitlistRoutes };
