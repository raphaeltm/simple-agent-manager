import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { bulkSweepMismatchedPersonalInstallations } from '../services/github-installation-leak-sweep';

/**
 * Hard ceiling on a caller-supplied `limit`. A single Workers request is bounded
 * by the 1000-subrequest limit and each swept row costs ~1 GitHub subrequest, so
 * keep the batch comfortably under that even if the caller asks for more.
 */
const MAX_LEAK_SWEEP_LIMIT = 500;

const adminGithubInstallationLeakSweepRoutes = new Hono<{ Bindings: Env }>();

adminGithubInstallationLeakSweepRoutes.use(
  '/*',
  requireAuth(),
  requireApproved(),
  requireSuperadmin()
);

/**
 * POST /api/admin/github-installation-leak-sweep — one-time (re-runnable) sweep
 * that deletes residual personal `github_installations` rows whose installation's
 * true GitHub account does NOT match the owning user's `github_id`.
 *
 * The webhook + OAuth owner guards stop NEW leaks; this heals rows inserted before
 * the guards existed. Only mismatched PERSONAL rows are deleted; org rows and
 * project-referenced rows (cascade guard) are never touched. Idempotent: matched
 * rows are left in place.
 *
 * Each invocation processes at most one batch (see the service for the limit and
 * its `GITHUB_INSTALLATION_LEAK_SWEEP_BATCH_SIZE` env override). When
 * `summary.hasMore` is true, more personal rows remain — the superadmin re-runs
 * with `afterId = summary.nextCursor` until it is false. Optional `limit` and
 * `afterId` in the request body override the batch size / starting cursor.
 */
adminGithubInstallationLeakSweepRoutes.post('/', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });

  let limit: number | undefined;
  let afterId: string | undefined;
  const body = await c.req.json().catch(() => null);
  if (body && typeof body.limit === 'number' && Number.isFinite(body.limit) && body.limit > 0) {
    // Cap the per-invocation batch: each row costs one GitHub subrequest plus a
    // few D1 reads/writes, and a single Workers request is bounded by the
    // 1000-subrequest / CPU-time limits. Clamp so a caller can't request a batch
    // big enough to blow the subrequest ceiling mid-sweep.
    limit = Math.min(Math.floor(body.limit), MAX_LEAK_SWEEP_LIMIT);
  }
  if (body && typeof body.afterId === 'string' && body.afterId.length > 0) {
    afterId = body.afterId;
  }

  log.info('admin.github_installation_leak_sweep.start', {
    limit: limit ?? null,
    afterId: afterId ?? null,
  });
  const summary = await bulkSweepMismatchedPersonalInstallations(db, c.env, { limit, afterId });

  return c.json({ summary });
});

export { adminGithubInstallationLeakSweepRoutes };
