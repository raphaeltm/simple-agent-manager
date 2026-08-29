import { isJsonRecord } from '@simple-agent-manager/shared';

import type { StorageSafetyConfig } from './storage-safety';

export const PROJECT_DATA_STORAGE_CLEANUP_HEALTH_STATES = [
  'not_needed',
  'running',
  'target_reached',
  'target_unreachable',
  'failed',
] as const;

export type ProjectDataStorageCleanupHealth =
  (typeof PROJECT_DATA_STORAGE_CLEANUP_HEALTH_STATES)[number];

export interface ProjectDataStorageCategoryBreakdown {
  measuredAt: number;
  totalDatabaseBytes: number;
  accountedPayloadBytes: number;
  unattributedBytes: number;
  reclaimableBytes: number;
  sessions: {
    totalRows: number;
    activeRows: number;
    sleepingRows: number;
    terminalRows: number;
    otherRows: number;
    topicBytes: number;
  };
  acpSessions: {
    totalRows: number;
    terminalRows: number;
    activeRows: number;
    promptBytes: number;
    errorBytes: number;
  };
  messages: {
    totalRows: number;
    contentBytes: number;
    toolMetadataBytes: number;
    activeOrSleepingSessionRows: number;
    activeOrSleepingSessionBytes: number;
    terminalSessionContentBytes: number;
    terminalLegacyToolPayloadRows: number;
    terminalLegacyToolPayloadBytes: number;
    terminalLegacyToolPayloadEligibleRows: number;
    terminalLegacyToolPayloadEligibleBytes: number;
    toolPayloadArchiveEligibleRows: number;
    toolPayloadArchiveEligibleBytes: number;
    normalizedToolMetadataRows: number;
    normalizedToolMetadataBytes: number;
  };
  activityEvents: {
    totalRows: number;
    payloadBytes: number;
    terminalEligibleRows: number;
    terminalEligiblePayloadBytes: number;
  };
  acpSessionEvents: {
    totalRows: number;
    reasonBytes: number;
    metadataBytes: number;
    terminalEligibleRows: number;
    terminalEligibleBytes: number;
  };
  taskStatusEvents: {
    totalRows: number;
    reasonBytes: number;
  };
  eventBus: {
    eventRows: number;
    subscriptionRows: number;
    deliveryRows: number;
    metadataBytes: number;
    payloadBytes: number;
    subscriptionFilterBytes: number;
    deliveryLastErrorBytes: number;
    retentionEligibleEventRows: number;
    retentionEligibleEventBytes: number;
    retentionEligibleDeliveryRows: number;
    retentionEligibleDeliveryBytes: number;
  };
}

function readNumber(row: unknown, key: string): number {
  if (!isJsonRecord(row)) return 0;
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function firstRow(
  sql: SqlStorage,
  statement: string,
  ...bindings: Array<number | string>
): unknown {
  return sql.exec(statement, ...bindings).toArray()[0];
}

function measureSessions(sql: SqlStorage): ProjectDataStorageCategoryBreakdown['sessions'] {
  const row = firstRow(
    sql,
    `SELECT
       COUNT(*) AS total_rows,
       COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active_rows,
       COALESCE(SUM(CASE WHEN status = 'sleeping' THEN 1 ELSE 0 END), 0) AS sleeping_rows,
       COALESCE(SUM(CASE WHEN status IN ('stopped', 'failed') THEN 1 ELSE 0 END), 0) AS terminal_rows,
       COALESCE(SUM(CASE WHEN status NOT IN ('active', 'sleeping', 'stopped', 'failed') THEN 1 ELSE 0 END), 0) AS other_rows,
       COALESCE(SUM(length(CAST(COALESCE(topic, '') AS BLOB))), 0) AS topic_bytes
     FROM chat_sessions`
  );

  return {
    totalRows: readNumber(row, 'total_rows'),
    activeRows: readNumber(row, 'active_rows'),
    sleepingRows: readNumber(row, 'sleeping_rows'),
    terminalRows: readNumber(row, 'terminal_rows'),
    otherRows: readNumber(row, 'other_rows'),
    topicBytes: readNumber(row, 'topic_bytes'),
  };
}

function measureAcpSessions(sql: SqlStorage): ProjectDataStorageCategoryBreakdown['acpSessions'] {
  const row = firstRow(
    sql,
    `SELECT
       COUNT(*) AS total_rows,
       COALESCE(SUM(CASE WHEN status IN ('completed', 'failed', 'interrupted') THEN 1 ELSE 0 END), 0) AS terminal_rows,
       COALESCE(SUM(CASE WHEN status IN ('pending', 'assigned', 'running') THEN 1 ELSE 0 END), 0) AS active_rows,
       COALESCE(SUM(length(CAST(COALESCE(initial_prompt, '') AS BLOB))), 0) AS prompt_bytes,
       COALESCE(SUM(length(CAST(COALESCE(error_message, '') AS BLOB))), 0) AS error_bytes
     FROM acp_sessions`
  );

  return {
    totalRows: readNumber(row, 'total_rows'),
    terminalRows: readNumber(row, 'terminal_rows'),
    activeRows: readNumber(row, 'active_rows'),
    promptBytes: readNumber(row, 'prompt_bytes'),
    errorBytes: readNumber(row, 'error_bytes'),
  };
}

function measureMessages(
  sql: SqlStorage,
  toolPayloadCutoffUpdatedAt: number,
  toolPayloadArchiveCutoffCreatedAt: number
): ProjectDataStorageCategoryBreakdown['messages'] {
  const row = firstRow(
    sql,
    `SELECT
       COUNT(*) AS total_rows,
       COALESCE(SUM(length(CAST(COALESCE(m.content, '') AS BLOB))), 0) AS content_bytes,
       COALESCE(SUM(length(CAST(COALESCE(m.tool_metadata, '') AS BLOB))), 0) AS tool_metadata_bytes,
       COALESCE(SUM(CASE WHEN s.status IN ('active', 'sleeping') THEN 1 ELSE 0 END), 0) AS active_sleeping_rows,
       COALESCE(SUM(
         CASE WHEN s.status IN ('active', 'sleeping')
           THEN length(CAST(COALESCE(m.content, '') AS BLOB))
              + length(CAST(COALESCE(m.tool_metadata, '') AS BLOB))
           ELSE 0
         END
       ), 0) AS active_sleeping_bytes,
       COALESCE(SUM(
         CASE WHEN s.status IN ('stopped', 'failed')
           THEN length(CAST(COALESCE(m.content, '') AS BLOB))
           ELSE 0
         END
       ), 0) AS terminal_content_bytes,
       COALESCE(SUM(
         CASE WHEN s.status IN ('stopped', 'failed')
                AND m.role = 'tool'
                AND m.tool_metadata LIKE '%"content"%'
           THEN 1
           ELSE 0
         END
       ), 0) AS terminal_legacy_tool_payload_rows,
       COALESCE(SUM(
         CASE WHEN s.status IN ('stopped', 'failed')
                AND m.role = 'tool'
                AND m.tool_metadata LIKE '%"content"%'
           THEN length(CAST(COALESCE(m.tool_metadata, '') AS BLOB))
           ELSE 0
         END
       ), 0) AS terminal_legacy_tool_payload_bytes,
       COALESCE(SUM(
         CASE WHEN s.status IN ('stopped', 'failed')
                AND s.updated_at <= ?
                AND m.role = 'tool'
                AND m.tool_metadata LIKE '%"content"%'
           THEN 1
           ELSE 0
         END
       ), 0) AS terminal_legacy_tool_payload_eligible_rows,
       COALESCE(SUM(
         CASE WHEN s.status IN ('stopped', 'failed')
                AND s.updated_at <= ?
                AND m.role = 'tool'
                AND m.tool_metadata LIKE '%"content"%'
           THEN length(CAST(COALESCE(m.tool_metadata, '') AS BLOB))
           ELSE 0
         END
       ), 0) AS terminal_legacy_tool_payload_eligible_bytes,
       COALESCE(SUM(
         CASE WHEN m.created_at < ?
                AND m.role = 'tool'
                AND m.tool_metadata LIKE '%"content"%'
           THEN 1
           ELSE 0
         END
       ), 0) AS tool_payload_archive_eligible_rows,
       COALESCE(SUM(
         CASE WHEN m.created_at < ?
                AND m.role = 'tool'
                AND m.tool_metadata LIKE '%"content"%'
           THEN length(CAST(COALESCE(m.tool_metadata, '') AS BLOB))
           ELSE 0
         END
       ), 0) AS tool_payload_archive_eligible_bytes,
       COALESCE(SUM(
         CASE WHEN m.role = 'tool'
                AND m.tool_metadata IS NOT NULL
                AND (s.status IS NULL OR s.status NOT IN ('active', 'sleeping'))
                AND NOT (
                  s.status IN ('stopped', 'failed')
                  AND m.tool_metadata LIKE '%"content"%'
                )
           THEN 1
           ELSE 0
         END
       ), 0) AS normalized_tool_metadata_rows,
       COALESCE(SUM(
         CASE WHEN m.role = 'tool'
                AND m.tool_metadata IS NOT NULL
                AND (s.status IS NULL OR s.status NOT IN ('active', 'sleeping'))
                AND NOT (
                  s.status IN ('stopped', 'failed')
                  AND m.tool_metadata LIKE '%"content"%'
                )
           THEN length(CAST(COALESCE(m.tool_metadata, '') AS BLOB))
           ELSE 0
         END
       ), 0) AS normalized_tool_metadata_bytes
     FROM chat_messages m
     LEFT JOIN chat_sessions s ON s.id = m.session_id`,
    toolPayloadCutoffUpdatedAt,
    toolPayloadCutoffUpdatedAt,
    toolPayloadArchiveCutoffCreatedAt,
    toolPayloadArchiveCutoffCreatedAt
  );

  return {
    totalRows: readNumber(row, 'total_rows'),
    contentBytes: readNumber(row, 'content_bytes'),
    toolMetadataBytes: readNumber(row, 'tool_metadata_bytes'),
    activeOrSleepingSessionRows: readNumber(row, 'active_sleeping_rows'),
    activeOrSleepingSessionBytes: readNumber(row, 'active_sleeping_bytes'),
    terminalSessionContentBytes: readNumber(row, 'terminal_content_bytes'),
    terminalLegacyToolPayloadRows: readNumber(row, 'terminal_legacy_tool_payload_rows'),
    terminalLegacyToolPayloadBytes: readNumber(row, 'terminal_legacy_tool_payload_bytes'),
    terminalLegacyToolPayloadEligibleRows: readNumber(
      row,
      'terminal_legacy_tool_payload_eligible_rows'
    ),
    terminalLegacyToolPayloadEligibleBytes: readNumber(
      row,
      'terminal_legacy_tool_payload_eligible_bytes'
    ),
    toolPayloadArchiveEligibleRows: readNumber(row, 'tool_payload_archive_eligible_rows'),
    toolPayloadArchiveEligibleBytes: readNumber(row, 'tool_payload_archive_eligible_bytes'),
    normalizedToolMetadataRows: readNumber(row, 'normalized_tool_metadata_rows'),
    normalizedToolMetadataBytes: readNumber(row, 'normalized_tool_metadata_bytes'),
  };
}

function measureActivityEvents(
  sql: SqlStorage,
  eventCutoffUpdatedAt: number
): ProjectDataStorageCategoryBreakdown['activityEvents'] {
  const row = firstRow(
    sql,
    `SELECT
       COUNT(*) AS total_rows,
       COALESCE(SUM(length(CAST(COALESCE(e.payload, '') AS BLOB))), 0) AS payload_bytes,
       COALESCE(SUM(
         CASE WHEN s.status IN ('stopped', 'failed')
                AND s.updated_at <= ?
           THEN 1
           ELSE 0
         END
       ), 0) AS terminal_eligible_rows,
       COALESCE(SUM(
         CASE WHEN s.status IN ('stopped', 'failed')
                AND s.updated_at <= ?
           THEN length(CAST(COALESCE(e.payload, '') AS BLOB))
           ELSE 0
         END
       ), 0) AS terminal_eligible_payload_bytes
     FROM activity_events e
     LEFT JOIN chat_sessions s ON s.id = e.session_id`,
    eventCutoffUpdatedAt,
    eventCutoffUpdatedAt
  );

  return {
    totalRows: readNumber(row, 'total_rows'),
    payloadBytes: readNumber(row, 'payload_bytes'),
    terminalEligibleRows: readNumber(row, 'terminal_eligible_rows'),
    terminalEligiblePayloadBytes: readNumber(row, 'terminal_eligible_payload_bytes'),
  };
}

function measureAcpSessionEvents(
  sql: SqlStorage,
  eventCutoffUpdatedAt: number
): ProjectDataStorageCategoryBreakdown['acpSessionEvents'] {
  const row = firstRow(
    sql,
    `SELECT
       COUNT(*) AS total_rows,
       COALESCE(SUM(length(CAST(COALESCE(e.reason, '') AS BLOB))), 0) AS reason_bytes,
       COALESCE(SUM(length(CAST(COALESCE(e.metadata, '') AS BLOB))), 0) AS metadata_bytes,
       COALESCE(SUM(
         CASE WHEN s.status IN ('stopped', 'failed')
                AND a.status IN ('completed', 'failed', 'interrupted')
                AND s.updated_at <= ?
           THEN 1
           ELSE 0
         END
       ), 0) AS terminal_eligible_rows,
       COALESCE(SUM(
         CASE WHEN s.status IN ('stopped', 'failed')
                AND a.status IN ('completed', 'failed', 'interrupted')
                AND s.updated_at <= ?
           THEN length(CAST(COALESCE(e.reason, '') AS BLOB))
              + length(CAST(COALESCE(e.metadata, '') AS BLOB))
           ELSE 0
         END
       ), 0) AS terminal_eligible_bytes
     FROM acp_session_events e
     LEFT JOIN acp_sessions a ON a.id = e.acp_session_id
     LEFT JOIN chat_sessions s ON s.id = a.chat_session_id`,
    eventCutoffUpdatedAt,
    eventCutoffUpdatedAt
  );

  return {
    totalRows: readNumber(row, 'total_rows'),
    reasonBytes: readNumber(row, 'reason_bytes'),
    metadataBytes: readNumber(row, 'metadata_bytes'),
    terminalEligibleRows: readNumber(row, 'terminal_eligible_rows'),
    terminalEligibleBytes: readNumber(row, 'terminal_eligible_bytes'),
  };
}

function measureTaskStatusEvents(
  sql: SqlStorage
): ProjectDataStorageCategoryBreakdown['taskStatusEvents'] {
  const row = firstRow(
    sql,
    `SELECT
       COUNT(*) AS total_rows,
       COALESCE(SUM(length(CAST(COALESCE(reason, '') AS BLOB))), 0) AS reason_bytes
     FROM task_status_events`
  );

  return {
    totalRows: readNumber(row, 'total_rows'),
    reasonBytes: readNumber(row, 'reason_bytes'),
  };
}

function measureEventBus(
  sql: SqlStorage,
  retentionCutoffCreatedAt: number
): ProjectDataStorageCategoryBreakdown['eventBus'] {
  const eventRow = firstRow(
    sql,
    `SELECT
       COUNT(*) AS event_rows,
       COALESCE(SUM(length(CAST(COALESCE(metadata, '') AS BLOB))), 0) AS metadata_bytes,
       COALESCE(SUM(length(CAST(COALESCE(payload, '') AS BLOB))), 0) AS payload_bytes,
       COALESCE(SUM(
         CASE WHEN created_at < ?
                AND NOT EXISTS (
                  SELECT 1
                  FROM event_bus_deliveries d
                  JOIN event_bus_delivery_policies p ON p.subscription_id = d.subscription_id
                  WHERE d.event_id = event_bus_events.id
                    AND p.policy = 'ack_required'
                    AND d.state IN ('queued', 'delivered')
                )
           THEN 1
           ELSE 0
         END
       ), 0) AS retention_eligible_event_rows,
       COALESCE(SUM(
         CASE WHEN created_at < ?
                AND NOT EXISTS (
                  SELECT 1
                  FROM event_bus_deliveries d
                  JOIN event_bus_delivery_policies p ON p.subscription_id = d.subscription_id
                  WHERE d.event_id = event_bus_events.id
                    AND p.policy = 'ack_required'
                    AND d.state IN ('queued', 'delivered')
                )
           THEN length(CAST(COALESCE(metadata, '') AS BLOB))
              + length(CAST(COALESCE(payload, '') AS BLOB))
           ELSE 0
         END
       ), 0) AS retention_eligible_event_bytes
     FROM event_bus_events`,
    retentionCutoffCreatedAt,
    retentionCutoffCreatedAt
  );
  const subscriptionRow = firstRow(
    sql,
    `SELECT
       COUNT(*) AS subscription_rows,
       COALESCE(SUM(
         length(CAST(COALESCE(event_types, '') AS BLOB))
         + length(CAST(COALESCE(subject_type, '') AS BLOB))
         + length(CAST(COALESCE(subject_id, '') AS BLOB))
       ), 0) AS subscription_filter_bytes
     FROM event_bus_subscriptions`
  );
  const deliveryRow = firstRow(
    sql,
    `SELECT
       COUNT(*) AS delivery_rows,
       COALESCE(SUM(length(CAST(COALESCE(last_error, '') AS BLOB))), 0) AS delivery_last_error_bytes
     FROM event_bus_deliveries`
  );
  const retentionDeliveryRow = firstRow(
    sql,
    `SELECT
       COUNT(*) AS retention_eligible_delivery_rows,
       COALESCE(SUM(length(CAST(COALESCE(d.last_error, '') AS BLOB))), 0) AS retention_eligible_delivery_bytes
     FROM event_bus_deliveries d
     JOIN event_bus_events e ON e.id = d.event_id
     WHERE e.created_at < ?
       AND NOT EXISTS (
         SELECT 1
         FROM event_bus_deliveries pending
         JOIN event_bus_delivery_policies p ON p.subscription_id = pending.subscription_id
         WHERE pending.event_id = e.id
           AND p.policy = 'ack_required'
           AND pending.state IN ('queued', 'delivered')
       )`,
    retentionCutoffCreatedAt
  );

  return {
    eventRows: readNumber(eventRow, 'event_rows'),
    subscriptionRows: readNumber(subscriptionRow, 'subscription_rows'),
    deliveryRows: readNumber(deliveryRow, 'delivery_rows'),
    metadataBytes: readNumber(eventRow, 'metadata_bytes'),
    payloadBytes: readNumber(eventRow, 'payload_bytes'),
    subscriptionFilterBytes: readNumber(subscriptionRow, 'subscription_filter_bytes'),
    deliveryLastErrorBytes: readNumber(deliveryRow, 'delivery_last_error_bytes'),
    retentionEligibleEventRows: readNumber(eventRow, 'retention_eligible_event_rows'),
    retentionEligibleEventBytes: readNumber(eventRow, 'retention_eligible_event_bytes'),
    retentionEligibleDeliveryRows: readNumber(
      retentionDeliveryRow,
      'retention_eligible_delivery_rows'
    ),
    retentionEligibleDeliveryBytes: readNumber(
      retentionDeliveryRow,
      'retention_eligible_delivery_bytes'
    ),
  };
}

export function measureProjectDataStorageCategories(
  sql: SqlStorage,
  config: Pick<
    StorageSafetyConfig,
    | 'toolPayloadCleanupMinSessionAgeMs'
    | 'toolPayloadArchiveRetentionMs'
    | 'eventLogCleanupMinSessionAgeMs'
    | 'eventBusRetentionMs'
  >,
  measuredAt: number
): ProjectDataStorageCategoryBreakdown {
  const toolPayloadCutoffUpdatedAt = measuredAt - config.toolPayloadCleanupMinSessionAgeMs;
  const toolPayloadArchiveCutoffCreatedAt = measuredAt - config.toolPayloadArchiveRetentionMs;
  const eventCutoffUpdatedAt = measuredAt - config.eventLogCleanupMinSessionAgeMs;
  const eventBusRetentionCutoffCreatedAt = measuredAt - config.eventBusRetentionMs;
  const sessions = measureSessions(sql);
  const acpSessions = measureAcpSessions(sql);
  const messages = measureMessages(
    sql,
    toolPayloadCutoffUpdatedAt,
    toolPayloadArchiveCutoffCreatedAt
  );
  const activityEvents = measureActivityEvents(sql, eventCutoffUpdatedAt);
  const acpSessionEvents = measureAcpSessionEvents(sql, eventCutoffUpdatedAt);
  const taskStatusEvents = measureTaskStatusEvents(sql);
  const eventBus = measureEventBus(sql, eventBusRetentionCutoffCreatedAt);
  const accountedPayloadBytes =
    sessions.topicBytes +
    acpSessions.promptBytes +
    acpSessions.errorBytes +
    messages.contentBytes +
    messages.toolMetadataBytes +
    activityEvents.payloadBytes +
    acpSessionEvents.reasonBytes +
    acpSessionEvents.metadataBytes +
    taskStatusEvents.reasonBytes +
    eventBus.metadataBytes +
    eventBus.payloadBytes +
    eventBus.subscriptionFilterBytes +
    eventBus.deliveryLastErrorBytes;
  const reclaimableBytes =
    messages.toolPayloadArchiveEligibleBytes +
    activityEvents.terminalEligiblePayloadBytes +
    acpSessionEvents.terminalEligibleBytes +
    eventBus.retentionEligibleEventBytes +
    eventBus.retentionEligibleDeliveryBytes;
  const totalDatabaseBytes = sql.databaseSize;

  return {
    measuredAt,
    totalDatabaseBytes,
    accountedPayloadBytes,
    unattributedBytes: Math.max(totalDatabaseBytes - accountedPayloadBytes, 0),
    reclaimableBytes,
    sessions,
    acpSessions,
    messages,
    activityEvents,
    acpSessionEvents,
    taskStatusEvents,
    eventBus,
  };
}
