import { TASK_TERMINAL_STATUSES } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { TRIGGER_RUN_TASK_ID_SQL } from './trigger-run-slots';

const TERMINAL_TASK_STATUSES = new Set<string>(TASK_TERMINAL_STATUSES);

export async function consecutiveFailureCount(
  env: Env,
  triggerId: string,
  threshold: number,
  excludeExecutionId?: string
): Promise<{ count: number; resetSequence: number | null }> {
  const rows = await env.DATABASE.prepare(
    `SELECT e.status, t.status AS taskStatus, tr.auto_pause_reset_sequence AS resetSequence
       FROM trigger_executions e
       LEFT JOIN tasks t ON t.id = ${TRIGGER_RUN_TASK_ID_SQL}
      JOIN triggers tr ON tr.id = e.trigger_id
      WHERE e.trigger_id = ? AND e.status NOT IN ('skipped','waiting','routing','routed','dropped')
        AND (? IS NULL OR e.id != ?)
        AND (tr.auto_pause_reset_sequence IS NULL OR e.sequence_number >= tr.auto_pause_reset_sequence)
      ORDER BY e.sequence_number DESC, e.created_at DESC LIMIT ?`
  )
    .bind(triggerId, excludeExecutionId ?? null, excludeExecutionId ?? null, threshold)
    .all<{ status: string; taskStatus: string | null; resetSequence: number | null }>();
  let count = 0;
  for (const row of rows.results) {
    const linkedTaskStillLive =
      row.taskStatus !== null && !TERMINAL_TASK_STATUSES.has(row.taskStatus);
    if (row.status !== 'failed' || linkedTaskStillLive) break;
    count += 1;
  }
  return { count, resetSequence: rows.results[0]?.resetSequence ?? null };
}
