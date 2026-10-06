import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ensureSessionTaskBacked } from '../services/session-task-repair';

const DEFAULT_SESSION_TASK_REPAIR_BATCH_SIZE = 25;
const MAX_SESSION_TASK_REPAIR_BATCH_SIZE = 200;

function repairBatchSize(env: Env): number {
  const parsed = Number.parseInt(env.SESSION_TASK_REPAIR_BATCH_SIZE ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SESSION_TASK_REPAIR_BATCH_SIZE;
  return Math.min(parsed, MAX_SESSION_TASK_REPAIR_BATCH_SIZE);
}

export interface SessionTaskReconciliationStats {
  scanned: number;
  repaired: number;
  reused: number;
  errors: number;
  residual: number;
}

export async function runSessionTaskReconciliation(
  env: Env
): Promise<SessionTaskReconciliationStats> {
  const limit = repairBatchSize(env);
  const rows = await env.DATABASE.prepare(
    'SELECT id, project_id, user_id FROM session_summaries WHERE task_id IS NULL ORDER BY updated_at DESC LIMIT ?'
  )
    .bind(limit)
    .all<{ id: string; project_id: string; user_id: string }>();

  const db = drizzle(env.DATABASE, { schema });
  let repaired = 0;
  let reused = 0;
  let errors = 0;

  for (const row of rows.results) {
    try {
      const task = await ensureSessionTaskBacked(db, env, {
        projectId: row.project_id,
        sessionId: row.id,
        fallbackUserId: row.user_id,
      });
      const update = await env.DATABASE.prepare(
        'UPDATE session_summaries SET task_id = ? WHERE id = ? AND task_id IS NULL'
      )
        .bind(task.id, row.id)
        .run();
      if (update.meta.changes > 0) repaired += 1;
      else reused += 1;
    } catch (err) {
      errors += 1;
      log.warn('session_task_reconciliation.repair_failed', {
        projectId: row.project_id,
        sessionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const residualRow = await env.DATABASE.prepare(
    'SELECT COUNT(*) AS count FROM session_summaries WHERE task_id IS NULL'
  ).first<{ count: number }>();
  const stats = {
    scanned: rows.results.length,
    repaired,
    reused,
    errors,
    residual: residualRow?.count ?? 0,
  };
  log.info('session_task_reconciliation.completed', stats);
  return stats;
}
