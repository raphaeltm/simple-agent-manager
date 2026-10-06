import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';

export interface VMErrorCorrelationRequest {
  workspaceId: string | null;
  /** Producer-authored incident time. Null means the report cannot be safely correlated. */
  timestamp: number | null;
}

export interface VMErrorCorrelation {
  taskId: string;
  sessionId: string;
}

export type VMErrorCorrelationRejectionReason =
  | 'missing_workspace_id'
  | 'invalid_incident_timestamp'
  | 'workspace_not_found'
  | 'node_mismatch'
  | 'canonical_task_missing'
  | 'outside_task_lifetime'
  | 'ambiguous_task_binding';

export type VMErrorCorrelationResult =
  | { correlation: VMErrorCorrelation; rejectionReason: null }
  | { correlation: null; rejectionReason: VMErrorCorrelationRejectionReason };

interface CorrelationRow {
  workspace_id: string;
  workspace_node_id: string | null;
  workspace_session_id: string | null;
  task_id: string | null;
  task_session_id: string | null;
  task_created_at: string | null;
  task_started_at: string | null;
  task_completed_at: string | null;
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function parseDatabaseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const normalized = hasTimezone ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isWithinTaskLifetime(row: CorrelationRow, timestamp: number): boolean {
  const startedAt = parseDatabaseTimestamp(row.task_started_at ?? row.task_created_at);
  if (startedAt === null || timestamp < startedAt) return false;
  const completedAt = parseDatabaseTimestamp(row.task_completed_at);
  return completedAt === null || timestamp <= completedAt;
}

/**
 * Resolve workspace-only VM reports to task/session IDs when D1 proves one
 * canonical binding. Missing, stale, cross-node, or inconsistent bindings stay
 * uncorrelated rather than risking evidence attachment to the wrong task.
 */
export async function correlateVMErrorsToTasks(
  db: D1Database,
  nodeId: string,
  requests: VMErrorCorrelationRequest[]
): Promise<VMErrorCorrelationResult[]> {
  const workspaceIds = [
    ...new Set(
      requests
        .map((request) => request.workspaceId?.trim() ?? '')
        .filter((workspaceId) => workspaceId.length > 0)
    ),
  ];
  if (workspaceIds.length === 0) {
    return requests.map((request) => ({
      correlation: null,
      rejectionReason: request.workspaceId ? 'workspace_not_found' : 'missing_workspace_id',
    }));
  }

  const rowsByWorkspace = new Map<string, CorrelationRow[]>();
  for (const workspaceBatch of chunk(workspaceIds, D1_MAX_BOUND_PARAMETERS)) {
    const placeholders = workspaceBatch.map(() => '?').join(',');
    const result = await db
      .prepare(
        `SELECT w.id AS workspace_id,
                w.node_id AS workspace_node_id,
                w.chat_session_id AS workspace_session_id,
                t.id AS task_id,
                t.chat_session_id AS task_session_id,
                t.created_at AS task_created_at,
                t.started_at AS task_started_at,
                t.completed_at AS task_completed_at
           FROM workspaces w
           LEFT JOIN tasks t
             ON t.workspace_id = w.id
            AND t.project_id = w.project_id
          WHERE w.id IN (${placeholders})`
      )
      .bind(...workspaceBatch)
      .all<CorrelationRow>();

    for (const row of result.results) {
      const rows = rowsByWorkspace.get(row.workspace_id) ?? [];
      rows.push(row);
      rowsByWorkspace.set(row.workspace_id, rows);
    }
  }

  return requests.map((request) => {
    if (!request.workspaceId) {
      return { correlation: null, rejectionReason: 'missing_workspace_id' };
    }
    const incidentTimestamp = request.timestamp;
    if (incidentTimestamp === null || !Number.isFinite(incidentTimestamp)) {
      return { correlation: null, rejectionReason: 'invalid_incident_timestamp' };
    }
    const rows = rowsByWorkspace.get(request.workspaceId) ?? [];
    if (rows.length === 0) {
      return { correlation: null, rejectionReason: 'workspace_not_found' };
    }
    if (rows.some((row) => row.workspace_node_id !== nodeId)) {
      return { correlation: null, rejectionReason: 'node_mismatch' };
    }
    const canonicalRows = rows.filter(
      (row) =>
        row.task_id !== null &&
        row.task_session_id !== null &&
        row.workspace_session_id !== null &&
        row.workspace_session_id === row.task_session_id
    );
    if (canonicalRows.length === 0) {
      return { correlation: null, rejectionReason: 'canonical_task_missing' };
    }
    const liveRows = canonicalRows.filter((row) => isWithinTaskLifetime(row, incidentTimestamp));
    if (liveRows.length === 0) {
      return { correlation: null, rejectionReason: 'outside_task_lifetime' };
    }
    if (liveRows.length !== 1) {
      return { correlation: null, rejectionReason: 'ambiguous_task_binding' };
    }
    const row = liveRows[0];
    if (!row?.task_id || !row.task_session_id) {
      return { correlation: null, rejectionReason: 'canonical_task_missing' };
    }
    return {
      correlation: { taskId: row.task_id, sessionId: row.task_session_id },
      rejectionReason: null,
    };
  });
}
