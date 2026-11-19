/**
 * `ops_timeline` sources for Operations telemetry: the node lifecycle decision log, black box
 * node log captures and sleep/wake step traces. Appended to `DEFAULT_TIMELINE_SOURCES`
 * (./timeline-sources.ts). Each reads one indexed D1 table bounded by the scope's IDs, window
 * and limit; error output from the VM goes in `text`, where it is treated as untrusted.
 */
import { anyIdIn } from './entity-graph';
// Type-only: `timeline-sources.ts` imports this module's array at load time, so a value import
// back from it would be a load-order cycle.
import type { TimelineEvent, TimelineScope, TimelineSource } from './timeline-sources';

type Row = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** The rows of `table` whose `column` is in `ids` and whose `created_at` is in the window. */
async function windowRows(
  env: Parameters<TimelineSource['collect']>[0],
  scope: TimelineScope,
  limit: number,
  query: { table: string; column: string; ids: readonly string[]; select: string }
): Promise<Row[]> {
  if (query.ids.length === 0) return [];
  // `anyIdIn` caps the ID list under D1's bound-parameter limit.
  const where = anyIdIn([[query.column, query.ids]]);
  const rows = await env.DATABASE.prepare(
    `SELECT ${query.select} FROM ${query.table}
      WHERE (${where.sql})
        AND created_at BETWEEN ? AND ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`
  )
    .bind(
      ...where.binds,
      new Date(scope.sinceMs).toISOString(),
      new Date(scope.untilMs).toISOString(),
      limit
    )
    .all<Row>();
  return rows.results ?? [];
}

function at(row: Row): string | null {
  const ms = Date.parse(String(row.created_at ?? ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export const nodeLifecycleDecisionSource: TimelineSource = {
  name: 'node_lifecycle_decisions',
  async collect(env, scope, limit) {
    const rows = await windowRows(env, scope, limit, {
      table: 'node_lifecycle_decisions',
      column: 'node_id',
      ids: scope.nodeIds,
      select: 'id, node_id, source, decision, reason, workspace_count, created_at',
    });
    return rows.flatMap((row): TimelineEvent[] => {
      const time = at(row);
      if (!time) return [];
      const count = typeof row.workspace_count === 'number' ? row.workspace_count : null;
      return [
        {
          at: time,
          source: 'node_lifecycle_decisions',
          kind: `node.decision.${str(row.decision) ?? 'unknown'}`,
          summary:
            `Node ${str(row.source) ?? 'lifecycle'} decision ${str(row.decision) ?? ''}` +
            (count === null ? '' : ` (${count} active workspaces)`),
          ids: { nodeId: str(row.node_id), decisionId: str(row.id) },
          ...(str(row.reason) ? { text: String(row.reason) } : {}),
        },
      ];
    });
  },
};

export const nodeLogCaptureSource: TimelineSource = {
  name: 'node_log_captures',
  async collect(env, scope, limit) {
    const rows = await windowRows(env, scope, limit, {
      table: 'node_log_captures',
      column: 'node_id',
      ids: scope.nodeIds,
      select: 'id, node_id, capture_trigger, status, entry_count, error, created_at',
    });
    return rows.flatMap((row): TimelineEvent[] => {
      const time = at(row);
      if (!time) return [];
      return [
        {
          at: time,
          source: 'node_log_captures',
          kind: `node.log_capture.${str(row.status) ?? 'unknown'}`,
          summary: `Black box log capture (${str(row.capture_trigger) ?? 'unknown trigger'}): ${
            str(row.status) ?? 'unknown'
          }, ${Number(row.entry_count ?? 0)} lines. Read with ops_get_node_log_capture.`,
          ids: { nodeId: str(row.node_id), captureId: str(row.id) },
          ...(str(row.error) ? { text: String(row.error) } : {}),
        },
      ];
    });
  },
};

export const snapshotTraceSource: TimelineSource = {
  name: 'session_snapshot_traces',
  async collect(env, scope, limit) {
    const rows = await windowRows(env, scope, limit, {
      table: 'session_snapshot_traces',
      column: 'chat_session_id',
      ids: scope.chatSessionIds,
      select:
        'id, chat_session_id, workspace_id, node_id, operation, outcome, failed_phase, total_ms, error_tail, created_at',
    });
    return rows.flatMap((row): TimelineEvent[] => {
      const time = at(row);
      if (!time) return [];
      const failed = str(row.failed_phase);
      return [
        {
          at: time,
          source: 'session_snapshot_traces',
          kind: `session.${str(row.operation) ?? 'snapshot'}.${str(row.outcome) ?? 'unknown'}`,
          summary:
            `${str(row.operation) ?? 'Snapshot'} ${str(row.outcome) ?? ''} in ${Number(
              row.total_ms ?? 0
            )} ms` + (failed ? `; failed at ${failed}` : ''),
          ids: {
            chatSessionId: str(row.chat_session_id),
            workspaceId: str(row.workspace_id),
            nodeId: str(row.node_id),
            traceId: str(row.id),
          },
          ...(str(row.error_tail) ? { text: String(row.error_tail) } : {}),
        },
      ];
    });
  },
};

export const TELEMETRY_TIMELINE_SOURCES: readonly TimelineSource[] = [
  nodeLifecycleDecisionSource,
  nodeLogCaptureSource,
  snapshotTraceSource,
];
