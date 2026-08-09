import type { DecisionAction } from '@simple-agent-manager/shared';

import { ulid } from '../../lib/ulid';

export function logDecision(
  sql: SqlStorage,
  missionId: string,
  taskId: string | null,
  action: DecisionAction,
  reason: string,
  now: number,
  metadata?: Record<string, unknown>
): void {
  sql.exec(
    `INSERT INTO decision_log (id, mission_id, task_id, action, reason, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ulid(),
    missionId,
    taskId,
    action,
    reason,
    metadata ? JSON.stringify(metadata) : null,
    now
  );
}

export function pruneDecisionLog(sql: SqlStorage, maxEntries: number): void {
  sql.exec(
    `DELETE FROM decision_log WHERE id NOT IN (
       SELECT id FROM decision_log ORDER BY created_at DESC LIMIT ?
     )`,
    maxEntries
  );
}
