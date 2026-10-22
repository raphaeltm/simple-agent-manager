/**
 * Which trigger executions hold one of their trigger's run slots, shared by admission's
 * reservation and its "why was this refused" classification so the two cannot disagree.
 */
import type { TriggerSkipReason } from '@simple-agent-manager/shared';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import {
  SLEEPING_TASK_STATUSES,
  taskStatusIsNonTerminalSql,
  TERMINAL_STATUS_VALUES,
} from './task-status';

export type AdmissionSkipReason = Extract<TriggerSkipReason, 'still_running' | 'concurrent_limit'>;

/**
 * Whether execution `e` (with its linked task `t` LEFT JOINed) still holds one of its
 * trigger's run slots, for both skip_if_running and max_concurrent. A reserved or
 * running execution holds it, and so does any execution whose linked task has not
 * terminalized, which covers the cleanup sweep's hard-residence backstop.
 *
 * A sleeping run does not: its task released the runtime and is not running. It stays
 * wakeable, so a follow-up can still resume it, but it must not block the next run
 * until its snapshot expires days later.
 *
 * Both task-status checks are denylists, so a new task status holds the slot until
 * someone decides otherwise (`packages/shared/.claude/rules/79`). The status
 * classification test in `trigger-admission-run-slot.test.ts` fails until it does.
 * Bind {@link EXECUTION_HOLDS_RUN_SLOT_BINDINGS} at this predicate's position.
 */
export const EXECUTION_HOLDS_RUN_SLOT_SQL = `(
  (
    e.status IN ('queued', 'running')
    OR (e.task_id IS NOT NULL AND ${taskStatusIsNonTerminalSql('t.status')})
    OR (e.status = 'failed' AND e.task_id IS NULL
      AND EXISTS (SELECT 1 FROM github_trigger_inbox g WHERE g.id = e.github_delivery_id AND g.state IN ('pending', 'processing')))
    OR (e.status = 'failed' AND e.task_id IS NULL
      AND EXISTS (SELECT 1 FROM trigger_email_messages m WHERE m.trigger_execution_id = e.id
        AND m.direction = 'inbound' AND m.status IN ('processing', 'failed')))
  )
  AND (t.status IS NULL OR t.status NOT IN (${SLEEPING_TASK_STATUSES.map(() => '?').join(', ')}))
)`;
export const EXECUTION_HOLDS_RUN_SLOT_BINDINGS = [
  ...TERMINAL_STATUS_VALUES,
  ...SLEEPING_TASK_STATUSES,
];

export async function classifyReservationFailure(
  env: Env,
  trigger: schema.TriggerRow
): Promise<'paused' | 'disabled' | AdmissionSkipReason> {
  const state = await env.DATABASE.prepare(
    `SELECT status, skip_if_running AS skipIfRunning, max_concurrent AS maxConcurrent,
       (SELECT COUNT(*) FROM trigger_executions e
          LEFT JOIN tasks t ON t.id = e.task_id
         WHERE e.trigger_id = triggers.id
           AND ${EXECUTION_HOLDS_RUN_SLOT_SQL}) AS activeCount
     FROM triggers WHERE id = ? AND project_id = ?`
  )
    .bind(...EXECUTION_HOLDS_RUN_SLOT_BINDINGS, trigger.id, trigger.projectId)
    .first<{
      status: string;
      skipIfRunning: number;
      maxConcurrent: number;
      activeCount: number;
    }>();
  if (!state || state.status === 'disabled') return 'disabled';
  if (state.status === 'paused') return 'paused';
  return state.skipIfRunning && state.activeCount > 0 ? 'still_running' : 'concurrent_limit';
}
