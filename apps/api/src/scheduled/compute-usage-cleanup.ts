/**
 * Scheduled job to close orphaned compute_usage records.
 *
 * Runs alongside the node cleanup sweep. Finds compute_usage rows
 * where ended_at IS NULL but the workspace is stopped/deleted/missing,
 * and closes them out.
 */
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../index';
import { log } from '../lib/logger';
import { closeOrphanedComputeUsage } from '../services/compute-usage';

export async function runComputeUsageCleanup(env: Env): Promise<number> {
  try {
    const db = drizzle(env.DATABASE, { schema });
    const closed = await closeOrphanedComputeUsage(db);
    if (closed > 0) {
      log.info('scheduled.compute_usage_cleanup', { closedRecords: closed });
    }
    return closed;
  } catch (err) {
    log.error('scheduled.compute_usage_cleanup_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
