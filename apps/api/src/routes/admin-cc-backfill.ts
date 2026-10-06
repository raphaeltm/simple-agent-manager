import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { runBackfill } from '../services/composable-credentials';

const adminCcBackfillRoutes = new Hono<{ Bindings: Env }>();

adminCcBackfillRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

/**
 * POST /api/admin/cc-backfill — populate cc_* tables from legacy credentials.
 *
 * Body: { dryRun?: boolean, userId?: string }
 * - dryRun: if true, returns what would be inserted without writing
 * - userId: scope to a single user (null = all users)
 *
 * Idempotent only on first run per user (re-running without clearing cc_* tables
 * will produce duplicate ID conflicts). Safe to re-run with dryRun=true anytime.
 */
adminCcBackfillRoutes.post('/', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });

  const body = await c.req.json().catch(() => ({}));
  const dryRun = body.dryRun === true;
  const userId = typeof body.userId === 'string' ? body.userId : null;

  log.info('admin.cc_backfill.start', { dryRun, userId });

  const report = await runBackfill(db, { dryRun, userId });

  log.info('admin.cc_backfill.complete', { ...report });

  return c.json({ report });
});

export { adminCcBackfillRoutes };
