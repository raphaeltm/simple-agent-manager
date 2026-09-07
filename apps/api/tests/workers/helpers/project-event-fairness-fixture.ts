/** Seed real canonical rows without invoking admission/materialization under test. */
function seedMatchedEvent(
  sql: SqlStorage,
  projectId: string,
  subscriptionId: string,
  key: string,
  at: number
): void {
  const eventId = `event-${key}`;
  sql.exec(
    `INSERT INTO project_events
    (id, project_id, contract_version, source, event_type, subject_type, subject_id,
     severity, delivery_key, payload_fingerprint, metadata_json, metadata_bytes,
     display_json, display_bytes, raw_payload_ref_json, raw_payload_ref_bytes,
     occurred_at, received_at, updated_at, state)
    VALUES (?, ?, 1, 'github', 'check_suite.completed', 'pull_request', ?,
      'warning', ?, ?, '{}', 2, '{"untrusted":true}', 18, NULL, 0, ?, ?, ?, 'recorded')`,
    eventId,
    projectId,
    key,
    `delivery-${key}`,
    `sha256:${key}`,
    at,
    at,
    at
  );
  sql.exec(
    `INSERT INTO project_event_matches
    (id, project_id, event_id, subscription_id, state, matched_at,
     lifecycle_checked_at, batch_id, reason)
    VALUES (?, ?, ?, ?, 'matched', ?, ?, NULL, NULL)`,
    `match-${key}`,
    projectId,
    eventId,
    subscriptionId,
    at,
    at
  );
}

/** Identical retained prefix for direct materialization and the real alarm fairness cases. */
export function seedMaterializationFairnessPrefix(
  sql: SqlStorage,
  projectId: string,
  blockedSubscriptionId: string,
  readySubscriptionId: string,
  prefix: 'fair' | 'alarm-fair'
): void {
  for (let index = 0; index < 120; index += 1) {
    seedMatchedEvent(
      sql,
      projectId,
      blockedSubscriptionId,
      `${prefix}-blocked-a-${index}`,
      1000 + index
    );
  }
  seedMatchedEvent(sql, projectId, readySubscriptionId, `${prefix}-ready-b`, 2000);
  sql.exec(
    `UPDATE project_event_subscriptions
    SET last_matched_at = CASE WHEN id = ? THEN 1000 WHEN id = ? THEN 2000 ELSE last_matched_at END,
        wake_due_at = CASE WHEN id = ? THEN 1000 WHEN id = ? THEN 2000 ELSE wake_due_at END
    WHERE project_id = ?`,
    blockedSubscriptionId,
    readySubscriptionId,
    blockedSubscriptionId,
    readySubscriptionId,
    projectId
  );
}
