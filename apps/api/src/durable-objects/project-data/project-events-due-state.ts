import { chunkIdsForBindBudget } from './project-events-storage-helpers';

export function refreshWakeDueAtForMatches(
  sql: SqlStorage,
  projectId: string,
  matchIds: string[],
  now: number
): void {
  for (const chunk of chunkIdsForBindBudget(matchIds, 1)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = sql
      .exec(
        `SELECT DISTINCT subscription_id
         FROM project_event_matches
         WHERE project_id = ? AND id IN (${placeholders})`,
        projectId,
        ...chunk
      )
      .toArray();
    for (const row of rows) {
      if (typeof row.subscription_id === 'string') {
        refreshWakeDueAtForSubscription(sql, projectId, row.subscription_id, now);
      }
    }
  }
}

export function refreshWakeDueAtForSubscription(
  sql: SqlStorage,
  projectId: string,
  subscriptionId: string,
  now: number
): void {
  sql.exec(
    `UPDATE project_event_subscriptions
     SET wake_due_at = (
           SELECT MIN(m.matched_at)
           FROM project_event_matches m
           WHERE m.project_id = project_event_subscriptions.project_id
             AND m.subscription_id = project_event_subscriptions.id
             AND m.state = 'matched'
             AND m.batch_id IS NULL
         ),
         updated_at = ?
     WHERE project_id = ? AND id = ?`,
    now,
    projectId,
    subscriptionId
  );
}
