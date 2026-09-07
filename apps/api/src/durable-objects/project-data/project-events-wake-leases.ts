export function readProjectEventWakeLeaseUntil(
  sql: SqlStorage,
  sessionId: string,
  now = Date.now()
): number | null {
  const pendingRow = sql
    .exec(
      `SELECT MIN(
                CASE
                  WHEN s.expires_at IS NULL THEN s.delivery_lifetime_expires_at
                  WHEN s.delivery_lifetime_expires_at IS NULL THEN s.expires_at
                  WHEN s.expires_at < s.delivery_lifetime_expires_at THEN s.expires_at
                  ELSE s.delivery_lifetime_expires_at
                END
              ) AS lease_until
       FROM project_event_subscriptions s
       WHERE s.target_session_id = ?
         AND s.contract_version >= 2
         AND s.lifecycle_state = 'active'
         AND s.requested_delivery = 'existing_session_prompt'
         AND s.resolved_delivery = 'queued_for_prompt_delivery'
         AND (s.expires_at IS NULL OR s.expires_at > ?)
         AND s.delivery_lifetime_expires_at IS NOT NULL
         AND s.delivery_lifetime_expires_at > ?
         AND EXISTS (
           SELECT 1 FROM project_event_matches m
           WHERE m.project_id = s.project_id
             AND m.subscription_id = s.id
             AND m.state = 'matched'
             AND m.batch_id IS NULL
         )`,
      sessionId,
      now,
      now
    )
    .toArray()[0];
  const pendingLease =
    typeof pendingRow?.lease_until === 'number' && pendingRow.lease_until > now
      ? pendingRow.lease_until
      : null;

  const batchRow = sql
    .exec(
      `SELECT MIN(
                CASE
                  WHEN delivery_expires_at IS NULL THEN readable_until
                  WHEN readable_until IS NULL THEN delivery_expires_at
                  WHEN delivery_expires_at < readable_until THEN delivery_expires_at
                  ELSE readable_until
                END
              ) AS lease_until
       FROM project_event_delivery_batches
       WHERE target_session_id = ?
         AND delivery_channel = 'prompt_queue'
         AND state IN ('pending', 'delivered')
         AND delivery_expires_at IS NOT NULL
         AND readable_until IS NOT NULL
         AND (delivery_expires_at > ? OR readable_until > ?)`,
      sessionId,
      now,
      now
    )
    .toArray()[0];
  const batchLease =
    typeof batchRow?.lease_until === 'number' && batchRow.lease_until > now
      ? batchRow.lease_until
      : null;

  if (pendingLease === null) return batchLease;
  if (batchLease === null) return pendingLease;
  return Math.min(pendingLease, batchLease);
}

export function hasProjectEventWakeLease(
  sql: SqlStorage,
  sessionId: string,
  now = Date.now()
): boolean {
  return readProjectEventWakeLeaseUntil(sql, sessionId, now) !== null;
}
