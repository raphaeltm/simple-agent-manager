import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { bulkBackfillGithubRepoIds } from '../services/github-repo-id-backfill';

const adminGithubRepoIdBackfillRoutes = new Hono<{ Bindings: Env }>();

adminGithubRepoIdBackfillRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

/**
 * POST /api/admin/github-repo-id-backfill — one-time bulk backfill of
 * `github_repo_id` for dormant legacy GitHub-backed projects.
 *
 * Part A (runtime.ts) self-heals projects the moment they mint a git token; this
 * route heals projects that never mint one. Idempotent: only touches rows where
 * github_repo_id IS NULL, so it is safe to re-run.
 *
 * Each invocation processes at most one batch (see the service for the limit and
 * its env override). When `summary.hasMore` is true, dormant projects remain — the
 * superadmin re-runs until it is false. An optional `limit` in the request body
 * overrides the batch size for a single run.
 */
adminGithubRepoIdBackfillRoutes.post('/', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });

  let limit: number | undefined;
  const body = await c.req.json().catch(() => null);
  if (body && typeof body.limit === 'number' && Number.isFinite(body.limit) && body.limit > 0) {
    limit = Math.floor(body.limit);
  }

  log.info('admin.github_repo_id_backfill.start', { limit: limit ?? null });
  const summary = await bulkBackfillGithubRepoIds(db, c.env, { limit });

  return c.json({ summary });
});

export { adminGithubRepoIdBackfillRoutes };
