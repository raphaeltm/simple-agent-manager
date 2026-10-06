import { TASK_TERMINAL_STATUSES } from '@simple-agent-manager/shared';

import { createModuleLogger } from '../../lib/logger';
import type { TaskWaitConfig } from './task-wait-config';

const log = createModuleLogger('project_data.task_waits');

export type TaskWaitCondition = 'all' | 'any';
export type TaskWaitState = 'active' | 'resolved' | 'cancelled';

export interface TaskWaitSubscription {
  id: string;
  parentTaskId: string;
  parentSessionId: string;
  idempotencyKey: string;
  condition: TaskWaitCondition;
  state: TaskWaitState;
  childCount: number;
  wakeDeadline: number;
  nextReconcileAt: number;
  wakeDeliveryId: string;
  wakeContent: string | null;
  wakeAttempts: number;
  resolutionReason: string | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  children: TaskWaitChild[];
}

export interface TaskWaitChild {
  childTaskId: string;
  observedStatus: string | null;
  observedAt: number | null;
}

export interface CreateTaskWaitInput {
  id: string;
  parentTaskId: string;
  parentSessionId: string;
  idempotencyKey?: string;
  condition: TaskWaitCondition;
  childTaskIds: string[];
  wakeDeadline: number;
  wakeDeliveryId: string;
}

export type RegisterTaskWaitInput = Omit<CreateTaskWaitInput, 'id' | 'wakeDeliveryId'>;

export interface TaskObservation {
  taskId: string;
  status: string;
}

export type TaskWaitDecision =
  | { action: 'pending' }
  | { action: 'wake'; reason: 'condition_met' | 'deadline_reached' };

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid task wait ${field}`);
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid task wait ${field}`);
  }
  return value;
}

function parseSubscriptionRow(
  row: Record<string, unknown>
): Omit<TaskWaitSubscription, 'children'> {
  const condition = asString(row.wait_condition, 'condition');
  const state = asString(row.state, 'state');
  if (condition !== 'all' && condition !== 'any') throw new Error('Invalid task wait condition');
  if (state !== 'active' && state !== 'resolved' && state !== 'cancelled') {
    throw new Error('Invalid task wait state');
  }
  return {
    id: asString(row.id, 'id'),
    parentTaskId: asString(row.parent_task_id, 'parentTaskId'),
    parentSessionId: asString(row.parent_session_id, 'parentSessionId'),
    idempotencyKey: asString(row.idempotency_key, 'idempotencyKey'),
    condition,
    state,
    childCount: asNumber(row.child_count, 'childCount'),
    wakeDeadline: asNumber(row.wake_deadline, 'wakeDeadline'),
    nextReconcileAt: asNumber(row.next_reconcile_at, 'nextReconcileAt'),
    wakeDeliveryId: asString(row.wake_delivery_id, 'wakeDeliveryId'),
    wakeContent: typeof row.wake_content === 'string' ? row.wake_content : null,
    wakeAttempts: asNumber(row.wake_attempts, 'wakeAttempts'),
    resolutionReason: typeof row.resolution_reason === 'string' ? row.resolution_reason : null,
    createdAt: asNumber(row.created_at, 'createdAt'),
    updatedAt: asNumber(row.updated_at, 'updatedAt'),
    resolvedAt: typeof row.resolved_at === 'number' ? row.resolved_at : null,
  };
}

function readChildren(sql: SqlStorage, subscriptionId: string): TaskWaitChild[] {
  return sql
    .exec(
      `SELECT child_task_id, observed_status, observed_at
			 FROM task_wait_children
			 WHERE subscription_id = ?
			 ORDER BY child_task_id`,
      subscriptionId
    )
    .toArray()
    .map((row) => ({
      childTaskId: asString(row.child_task_id, 'childTaskId'),
      observedStatus: typeof row.observed_status === 'string' ? row.observed_status : null,
      observedAt: typeof row.observed_at === 'number' ? row.observed_at : null,
    }));
}

function hydrate(sql: SqlStorage, row: Record<string, unknown>): TaskWaitSubscription {
  const subscription = parseSubscriptionRow(row);
  return { ...subscription, children: readChildren(sql, subscription.id) };
}

export function createTaskWait(
  sql: SqlStorage,
  config: TaskWaitConfig,
  input: CreateTaskWaitInput,
  now = Date.now()
): { created: boolean; subscription: TaskWaitSubscription } {
  // Explicit code-unit comparator, NOT the default sort and NOT localeCompare.
  // This order feeds the derived idempotency key below, so it must be stable
  // across isolates and runtime versions; localeCompare is locale-dependent and
  // could reorder ids under a different default locale, silently producing a
  // second "distinct" wait for the same child set.
  const childTaskIds = [...new Set(input.childTaskIds)].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  if (childTaskIds.length === 0) throw new Error('At least one child task is required');
  if (childTaskIds.length > config.maxChildren) {
    throw new Error(`Task wait child limit reached (${config.maxChildren})`);
  }

  const idempotencyKey =
    input.idempotencyKey?.trim() || `${input.condition}:${childTaskIds.join(',')}`;
  const idempotentRow = sql
    .exec(
      `SELECT * FROM task_wait_subscriptions
			 WHERE parent_task_id = ? AND idempotency_key = ?
			 LIMIT 1`,
      input.parentTaskId,
      idempotencyKey
    )
    .toArray()[0];
  if (idempotentRow) {
    const existing = hydrate(sql, idempotentRow);
    const existingIds = existing.children.map((child) => child.childTaskId);
    if (
      existing.parentSessionId !== input.parentSessionId ||
      existing.condition !== input.condition ||
      JSON.stringify(existingIds) !== JSON.stringify(childTaskIds)
    ) {
      throw new Error('Task wait idempotency key belongs to a different wait intent');
    }
    return { created: false, subscription: existing };
  }

  const existingRow = sql
    .exec(
      `SELECT * FROM task_wait_subscriptions
			 WHERE parent_task_id = ? AND state = 'active'
			 LIMIT 1`,
      input.parentTaskId
    )
    .toArray()[0];
  if (existingRow) {
    const existing = hydrate(sql, existingRow);
    const existingIds = existing.children.map((child) => child.childTaskId);
    if (
      existing.condition === input.condition &&
      JSON.stringify(existingIds) === JSON.stringify(childTaskIds)
    ) {
      return { created: false, subscription: existing };
    }
    throw new Error('Parent task already has a different active wait subscription');
  }

  const activeCountRow = sql
    .exec(`SELECT COUNT(*) AS count FROM task_wait_subscriptions WHERE state = 'active'`)
    .toArray()[0];
  const activeCount = typeof activeCountRow?.count === 'number' ? activeCountRow.count : 0;
  if (activeCount >= config.maxActivePerProject) {
    throw new Error(`Active task wait limit reached (${config.maxActivePerProject})`);
  }

  sql.exec(
    `INSERT INTO task_wait_subscriptions (
		   id, parent_task_id, parent_session_id, wait_condition, state,
		   idempotency_key, child_count, wake_deadline, next_reconcile_at, wake_delivery_id,
		   created_at, updated_at
		 ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.parentTaskId,
    input.parentSessionId,
    input.condition,
    idempotencyKey,
    childTaskIds.length,
    input.wakeDeadline,
    now,
    input.wakeDeliveryId,
    now,
    now
  );
  for (const childTaskId of childTaskIds) {
    sql.exec(
      `INSERT INTO task_wait_children (subscription_id, child_task_id)
			 VALUES (?, ?)`,
      input.id,
      childTaskId
    );
  }
  const subscription = getTaskWait(sql, input.id);
  if (!subscription) throw new Error('Task wait insert was not readable');
  return { created: true, subscription };
}

export function getTaskWait(sql: SqlStorage, subscriptionId: string): TaskWaitSubscription | null {
  const row = sql
    .exec(`SELECT * FROM task_wait_subscriptions WHERE id = ?`, subscriptionId)
    .toArray()[0];
  return row ? hydrate(sql, row) : null;
}

export function listTaskWaitCandidates(
  sql: SqlStorage,
  config: TaskWaitConfig,
  now = Date.now(),
  relatedTaskId?: string
): TaskWaitSubscription[] {
  const rows = relatedTaskId
    ? sql
        .exec(
          `SELECT subscriptions.*
           FROM task_wait_subscriptions subscriptions
           WHERE subscriptions.state = 'active'
             AND (
               subscriptions.parent_task_id = ?
               OR EXISTS (
                 SELECT 1 FROM task_wait_children children
                 WHERE children.subscription_id = subscriptions.id
                   AND children.child_task_id = ?
               )
             )
           ORDER BY subscriptions.created_at
           LIMIT ?`,
          relatedTaskId,
          relatedTaskId,
          config.maxCandidatesPerAlarm
        )
        .toArray()
    : sql
        .exec(
          `SELECT * FROM task_wait_subscriptions
					 WHERE state = 'active'
					   AND CASE
					     WHEN wake_attempts > 0 THEN next_reconcile_at <= ?
					     ELSE (next_reconcile_at <= ? OR wake_deadline <= ?)
					   END
					 ORDER BY CASE
					   WHEN wake_attempts > 0 THEN next_reconcile_at
					   ELSE MIN(next_reconcile_at, wake_deadline)
					 END, created_at
					 LIMIT ?`,
          now,
          now,
          now,
          config.maxCandidatesPerAlarm
        )
        .toArray();
  // Per-row fault isolation (.claude/rules/50). `hydrate` -> `parseSubscriptionRow`
  // throws on any unexpected row shape, so an unguarded `rows.map(hydrate)` would
  // let ONE malformed subscription discard the whole due-candidate batch. That is
  // worse here than for an ordinary list read: the throw happens before any
  // mutation, so the bad row is never marked terminal and every subsequent alarm
  // tick re-selects it — permanently blocking reconciliation for every OTHER wait
  // in the project (the immortal-candidate failure rule 47 exists to prevent).
  const candidates: TaskWaitSubscription[] = [];
  for (const row of rows) {
    try {
      candidates.push(hydrate(sql, row));
    } catch (error) {
      log.warn('task_wait.candidate_row_skipped', {
        subscriptionId: typeof row.id === 'string' ? row.id : null,
        parentTaskId: typeof row.parent_task_id === 'string' ? row.parent_task_id : null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return candidates;
}

export function recordTaskWaitObservations(
  sql: SqlStorage,
  subscriptionId: string,
  observations: ReadonlyMap<string, TaskObservation>,
  now: number,
  nextReconcileAt: number
): TaskWaitSubscription | null {
  const current = getTaskWait(sql, subscriptionId);
  if (!current || current.state !== 'active') return current;
  for (const child of current.children) {
    const observation = observations.get(child.childTaskId);
    sql.exec(
      `UPDATE task_wait_children
			 SET observed_status = ?, observed_at = ?
			 WHERE subscription_id = ? AND child_task_id = ?`,
      observation?.status ?? 'missing',
      now,
      subscriptionId,
      child.childTaskId
    );
  }
  sql.exec(
    `UPDATE task_wait_subscriptions
		 SET next_reconcile_at = ?,
		     wake_attempts = CASE WHEN wake_content IS NULL THEN 0 ELSE wake_attempts END,
		     updated_at = ?
		 WHERE id = ? AND state = 'active'`,
    nextReconcileAt,
    now,
    subscriptionId
  );
  return getTaskWait(sql, subscriptionId);
}

export function decideTaskWait(subscription: TaskWaitSubscription, now: number): TaskWaitDecision {
  if (
    subscription.wakeContent !== null &&
    (subscription.resolutionReason === 'condition_met' ||
      subscription.resolutionReason === 'deadline_reached')
  ) {
    return { action: 'wake', reason: subscription.resolutionReason };
  }
  const terminal = new Set<string>([...TASK_TERMINAL_STATUSES, 'missing']);
  const terminalCount = subscription.children.filter((child) =>
    terminal.has(child.observedStatus ?? '')
  ).length;
  const conditionMet =
    subscription.condition === 'all'
      ? terminalCount === subscription.childCount
      : terminalCount > 0;
  if (conditionMet) return { action: 'wake', reason: 'condition_met' };
  if (subscription.wakeDeadline <= now) {
    return { action: 'wake', reason: 'deadline_reached' };
  }
  return { action: 'pending' };
}

export function prepareTaskWaitWake(
  sql: SqlStorage,
  subscriptionId: string,
  reason: 'condition_met' | 'deadline_reached',
  content: string,
  now: number
): TaskWaitSubscription | null {
  sql.exec(
    `UPDATE task_wait_subscriptions
		 SET wake_content = ?, resolution_reason = ?, updated_at = ?
		 WHERE id = ? AND state = 'active' AND wake_content IS NULL`,
    content,
    reason,
    now,
    subscriptionId
  );
  return getTaskWait(sql, subscriptionId);
}

export function recordTaskWaitWakeFailure(
  sql: SqlStorage,
  subscriptionId: string,
  now: number,
  nextAttemptAt: number,
  maxAttempts: number
): { cancelled: boolean; attempts: number } | null {
  const current = getTaskWait(sql, subscriptionId);
  if (!current || current.state !== 'active') return null;
  const attempts = current.wakeAttempts + 1;
  const cancelled = attempts >= maxAttempts;
  sql.exec(
    `UPDATE task_wait_subscriptions
		 SET wake_attempts = ?, next_reconcile_at = ?,
		     state = CASE WHEN ? = 1 THEN 'cancelled' ELSE state END,
		     resolution_reason = CASE WHEN ? = 1 THEN 'wake_delivery_failed' ELSE resolution_reason END,
		     resolved_at = CASE WHEN ? = 1 THEN ? ELSE resolved_at END,
		     updated_at = ?
		 WHERE id = ? AND state = 'active'`,
    attempts,
    nextAttemptAt,
    cancelled ? 1 : 0,
    cancelled ? 1 : 0,
    cancelled ? 1 : 0,
    now,
    now,
    subscriptionId
  );
  return { cancelled, attempts };
}

export function resolveTaskWait(
  sql: SqlStorage,
  subscriptionId: string,
  reason: string,
  now: number
): boolean {
  return (
    sql.exec(
      `UPDATE task_wait_subscriptions
			 SET state = 'resolved', resolution_reason = ?, resolved_at = ?, updated_at = ?
			 WHERE id = ? AND state = 'active'`,
      reason,
      now,
      now,
      subscriptionId
    ).rowsWritten > 0
  );
}

export function cancelTaskWait(
  sql: SqlStorage,
  subscriptionId: string,
  reason: string,
  now: number
): boolean {
  return (
    sql.exec(
      `UPDATE task_wait_subscriptions
			 SET state = 'cancelled', resolution_reason = ?, resolved_at = ?, updated_at = ?
			 WHERE id = ? AND state = 'active'`,
      reason,
      now,
      now,
      subscriptionId
    ).rowsWritten > 0
  );
}

export function computeTaskWaitAlarmTime(sql: SqlStorage): number | null {
  const row = sql
    .exec(
      `SELECT MIN(CASE
			   WHEN wake_attempts > 0 THEN next_reconcile_at
			   ELSE MIN(next_reconcile_at, wake_deadline)
			 END) AS due_at
			 FROM task_wait_subscriptions
			 WHERE state = 'active'`
    )
    .toArray()[0];
  return typeof row?.due_at === 'number' ? row.due_at : null;
}
