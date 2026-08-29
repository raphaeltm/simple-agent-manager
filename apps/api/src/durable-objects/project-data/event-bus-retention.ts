import type { EventBusStorageConfig } from './event-bus-config';
import { readOptionalNumberColumn, readRequiredStringColumn } from './event-bus-row-parsers';

export interface EventBusRetentionResult {
  cutoffCreatedAt: number;
  eventsDeleted: number;
  deliveriesDeleted: number;
  exhaustedCandidates: boolean;
}

export function runEventBusRetention(
  sql: SqlStorage,
  config: Pick<EventBusStorageConfig, 'retentionMs' | 'retentionBatchRows'>,
  now = Date.now()
): EventBusRetentionResult {
  const cutoffCreatedAt = now - config.retentionMs;
  const candidateRows = sql
    .exec(
      `SELECT e.id
       FROM event_bus_events e
       WHERE e.created_at < ?
         AND NOT EXISTS (
           SELECT 1
           FROM event_bus_deliveries d
           JOIN event_bus_delivery_policies p ON p.subscription_id = d.subscription_id
           WHERE d.event_id = e.id
             AND p.policy = 'ack_required'
             AND d.state IN ('queued', 'delivered')
         )
       ORDER BY e.created_at ASC, e.sequence ASC
       LIMIT ?`,
      cutoffCreatedAt,
      config.retentionBatchRows + 1
    )
    .toArray();
  const eventIds = candidateRows
    .slice(0, config.retentionBatchRows)
    .map((row) => readRequiredStringColumn(row, 'id', 'event_bus.retention_candidate.row'))
    .filter((id) => id.length > 0);

  if (eventIds.length === 0) {
    return {
      cutoffCreatedAt,
      eventsDeleted: 0,
      deliveriesDeleted: 0,
      exhaustedCandidates: true,
    };
  }

  const placeholders = eventIds.map(() => '?').join(', ');
  const deliveriesBefore = readCount(
    sql,
    `SELECT COUNT(*) AS count FROM event_bus_deliveries WHERE event_id IN (${placeholders})`,
    eventIds
  );
  sql.exec(`DELETE FROM event_bus_deliveries WHERE event_id IN (${placeholders})`, ...eventIds);
  sql.exec(`DELETE FROM event_bus_events WHERE id IN (${placeholders})`, ...eventIds);

  return {
    cutoffCreatedAt,
    eventsDeleted: eventIds.length,
    deliveriesDeleted: deliveriesBefore,
    exhaustedCandidates: candidateRows.length <= config.retentionBatchRows,
  };
}

export function computeEventBusRetentionAlarmTime(
  sql: SqlStorage,
  config: Pick<EventBusStorageConfig, 'retentionMs'>,
  now = Date.now()
): number | null {
  const [row] = sql
    .exec(
      `SELECT e.created_at
       FROM event_bus_events e
       WHERE NOT EXISTS (
         SELECT 1
         FROM event_bus_deliveries d
         JOIN event_bus_delivery_policies p ON p.subscription_id = d.subscription_id
         WHERE d.event_id = e.id
           AND p.policy = 'ack_required'
           AND d.state IN ('queued', 'delivered')
       )
       ORDER BY e.created_at ASC, e.sequence ASC
       LIMIT 1`
    )
    .toArray();
  const createdAt = readOptionalNumberColumn(row, 'created_at', 'event_bus.retention_alarm.row');
  return createdAt === null ? null : Math.max(createdAt + config.retentionMs, now);
}

function readCount(sql: SqlStorage, statement: string, bindings: unknown[]): number {
  const [row] = sql.exec(statement, ...bindings).toArray();
  return readOptionalNumberColumn(row, 'count', 'event_bus.count.row') ?? 0;
}
