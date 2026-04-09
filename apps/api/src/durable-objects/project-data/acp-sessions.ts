/**
 * ACP Session Lifecycle — DO-owned session state machine (Spec 027).
 */
import type {
  AcpSession,
  AcpSessionEventActorType,
  AcpSessionStatus,
} from '@simple-agent-manager/shared';
import {
  ACP_SESSION_DEFAULTS,
  ACP_SESSION_TERMINAL_STATUSES,
  ACP_SESSION_VALID_TRANSITIONS,
} from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import {
  parseAcpSessionHeartbeatCheck,
  parseAcpSessionLineage,
  parseAcpSessionRow,
  parseAcpSessionStale,
  parseCountCnt,
  parseMinEarliest,
} from './row-schemas';
import type { Env } from './types';
import { generateId } from './types';

export { parseAcpSessionRow as mapAcpSessionRow };

export function createAcpSession(
  sql: SqlStorage,
  opts: {
    chatSessionId: string;
    initialPrompt: string | null;
    agentType: string | null;
    parentSessionId?: string | null;
    forkDepth?: number;
  }
): AcpSession {
  const chatSession = sql
    .exec('SELECT id FROM chat_sessions WHERE id = ?', opts.chatSessionId)
    .toArray()[0];
  if (!chatSession) {
    throw new Error(`Chat session ${opts.chatSessionId} not found`);
  }

  const id = generateId();
  const now = Date.now();

  sql.exec(
    `INSERT INTO acp_sessions (id, chat_session_id, parent_session_id, status, agent_type, initial_prompt, fork_depth, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    id,
    opts.chatSessionId,
    opts.parentSessionId ?? null,
    opts.agentType ?? null,
    opts.initialPrompt ?? null,
    opts.forkDepth ?? 0,
    now,
    now
  );

  recordAcpSessionEvent(sql, id, null, 'pending', 'system', null, 'Session created');

  return getAcpSessionOrThrow(sql, id);
}

export function getAcpSession(sql: SqlStorage, sessionId: string): AcpSession | null {
  const row = sql
    .exec('SELECT * FROM acp_sessions WHERE id = ?', sessionId)
    .toArray()[0];
  return row ? parseAcpSessionRow(row) : null;
}

export function listAcpSessions(
  sql: SqlStorage,
  opts?: {
    chatSessionId?: string;
    status?: AcpSessionStatus;
    nodeId?: string;
    limit?: number;
    offset?: number;
  }
): { sessions: AcpSession[]; total: number } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts?.chatSessionId) {
    conditions.push('chat_session_id = ?');
    params.push(opts.chatSessionId);
  }
  if (opts?.status) {
    conditions.push('status = ?');
    params.push(opts.status);
  }
  if (opts?.nodeId) {
    conditions.push('node_id = ?');
    params.push(opts.nodeId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  const totalRow = sql
    .exec(`SELECT COUNT(*) as cnt FROM acp_sessions ${where}`, ...params)
    .toArray()[0];

  const rows = sql
    .exec(
      `SELECT * FROM acp_sessions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset
    )
    .toArray();

  return {
    sessions: rows.map((row) => parseAcpSessionRow(row)),
    total: totalRow ? parseCountCnt(totalRow, 'acp_sessions.list_total') : 0,
  };
}

/**
 * Transition an ACP session to a new state with validation.
 * Returns the updated session. Does NOT schedule alarms — caller must do that.
 */
export function transitionAcpSession(
  sql: SqlStorage,
  sessionId: string,
  toStatus: AcpSessionStatus,
  opts: {
    actorType: AcpSessionEventActorType;
    actorId?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown> | null;
    workspaceId?: string;
    nodeId?: string;
    acpSdkSessionId?: string;
    errorMessage?: string;
  },
  projectId: string | null
): { session: AcpSession; fromStatus: AcpSessionStatus; chatSessionId: string } {
  const rawRow = sql
    .exec('SELECT * FROM acp_sessions WHERE id = ?', sessionId)
    .toArray()[0];

  if (!rawRow) {
    throw new Error(`ACP session ${sessionId} not found`);
  }

  const current = parseAcpSessionRow(rawRow);
  const fromStatus = current.status;
  const validTargets = ACP_SESSION_VALID_TRANSITIONS[fromStatus];

  if (!validTargets.includes(toStatus)) {
    log.error('acp_session.invalid_transition', {
      sessionId,
      chatSessionId: current.chatSessionId,
      projectId,
      fromStatus,
      toStatus,
      action: 'rejected',
    });
    throw new Error(
      `Invalid ACP session transition: ${fromStatus} → ${toStatus} (session ${sessionId})`
    );
  }

  const now = Date.now();

  if (toStatus === 'assigned') {
    sql.exec(
      `UPDATE acp_sessions SET status = ?, workspace_id = ?, node_id = ?, assigned_at = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ?`,
      toStatus, opts.workspaceId ?? null, opts.nodeId ?? null, now, now, now, sessionId
    );
  } else if (toStatus === 'running') {
    sql.exec(
      `UPDATE acp_sessions SET status = ?, acp_sdk_session_id = ?, started_at = ?, updated_at = ? WHERE id = ?`,
      toStatus, opts.acpSdkSessionId ?? null, now, now, sessionId
    );
  } else if (toStatus === 'completed' || toStatus === 'failed') {
    sql.exec(
      `UPDATE acp_sessions SET status = ?, completed_at = ?, error_message = ?, updated_at = ? WHERE id = ?`,
      toStatus, now, opts.errorMessage ?? null, now, sessionId
    );
  } else if (toStatus === 'interrupted') {
    sql.exec(
      `UPDATE acp_sessions SET status = ?, interrupted_at = ?, error_message = ?, updated_at = ? WHERE id = ?`,
      toStatus, now, opts.errorMessage ?? null, now, sessionId
    );
  } else {
    sql.exec(
      `UPDATE acp_sessions SET status = ?, updated_at = ? WHERE id = ?`,
      toStatus, now, sessionId
    );
  }

  recordAcpSessionEvent(
    sql,
    sessionId,
    fromStatus,
    toStatus,
    opts.actorType,
    opts.actorId ?? null,
    opts.reason ?? null,
    opts.metadata ?? null
  );

  log.info('acp_session.transitioned', {
    sessionId,
    chatSessionId: current.chatSessionId,
    workspaceId: opts.workspaceId ?? current.workspaceId,
    nodeId: opts.nodeId ?? current.nodeId,
    projectId,
    fromStatus,
    toStatus,
  });

  return {
    session: getAcpSessionOrThrow(sql, sessionId),
    fromStatus,
    chatSessionId: current.chatSessionId,
  };
}

export function updateHeartbeat(
  sql: SqlStorage,
  sessionId: string,
  nodeId: string,
  projectId: string | null
): void {
  const row = sql
    .exec('SELECT id, node_id, status FROM acp_sessions WHERE id = ?', sessionId)
    .toArray()[0];

  if (!row) {
    throw new Error(`ACP session ${sessionId} not found`);
  }

  const session = parseAcpSessionHeartbeatCheck(row);

  if (session.nodeId !== nodeId) {
    log.error('acp_session.heartbeat_node_mismatch', {
      sessionId,
      expectedNodeId: session.nodeId,
      receivedNodeId: nodeId,
      projectId,
      action: 'rejected',
    });
    throw new Error(`Node mismatch: session assigned to ${session.nodeId}, heartbeat from ${nodeId}`);
  }

  if (!['assigned', 'running'].includes(session.status)) {
    log.warn('acp_session.heartbeat_for_inactive_session', {
      sessionId,
      nodeId,
      projectId,
      sessionStatus: session.status,
      action: 'rejected',
    });
    throw new Error(
      `Heartbeat rejected: session ${sessionId} is in "${session.status}" state, not assigned or running`
    );
  }

  const now = Date.now();
  sql.exec(
    'UPDATE acp_sessions SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?',
    now,
    now,
    sessionId
  );
}

export function forkAcpSession(
  sql: SqlStorage,
  env: Env,
  sessionId: string,
  contextSummary: string,
  projectId: string | null
): AcpSession {
  const rawRow = sql
    .exec('SELECT * FROM acp_sessions WHERE id = ?', sessionId)
    .toArray()[0];

  if (!rawRow) {
    throw new Error(`ACP session ${sessionId} not found`);
  }

  const parent = parseAcpSessionRow(rawRow);

  if (!ACP_SESSION_TERMINAL_STATUSES.includes(parent.status)) {
    log.warn('acp_session.fork_invalid_state', {
      sessionId,
      projectId,
      parentStatus: parent.status,
      action: 'rejected',
    });
    throw new Error(
      `Cannot fork session in "${parent.status}" state — must be completed, failed, or interrupted`
    );
  }

  const maxDepth = parseInt(
    env.ACP_SESSION_MAX_FORK_DEPTH || String(ACP_SESSION_DEFAULTS.MAX_FORK_DEPTH),
    10
  );
  if (parent.forkDepth >= maxDepth) {
    log.warn('acp_session.fork_depth_exceeded', {
      sessionId,
      projectId,
      parentDepth: parent.forkDepth,
      maxDepth,
      action: 'rejected',
    });
    throw new Error(
      `Fork depth ${parent.forkDepth + 1} exceeds maximum ${maxDepth}`
    );
  }

  return createAcpSession(sql, {
    chatSessionId: parent.chatSessionId,
    initialPrompt: contextSummary,
    agentType: parent.agentType,
    parentSessionId: sessionId,
    forkDepth: parent.forkDepth + 1,
  });
}

export function getAcpSessionLineage(sql: SqlStorage, sessionId: string): AcpSession[] {
  let rootId = sessionId;
  const visited = new Set<string>([rootId]);
  let rawRow = sql
    .exec('SELECT id, parent_session_id FROM acp_sessions WHERE id = ?', rootId)
    .toArray()[0];

  while (rawRow) {
    const current = parseAcpSessionLineage(rawRow);
    if (!current.parentSessionId) break;
    if (visited.has(current.parentSessionId)) break;
    visited.add(current.parentSessionId);
    rootId = current.parentSessionId;
    rawRow = sql
      .exec('SELECT id, parent_session_id FROM acp_sessions WHERE id = ?', rootId)
      .toArray()[0];
  }

  const rows = sql
    .exec(
      `WITH RECURSIVE lineage AS (
        SELECT * FROM acp_sessions WHERE id = ?
        UNION ALL
        SELECT s.* FROM acp_sessions s
        INNER JOIN lineage l ON s.parent_session_id = l.id
      )
      SELECT * FROM lineage ORDER BY fork_depth, created_at`,
      rootId
    )
    .toArray();

  return rows.map((row) => parseAcpSessionRow(row));
}

export function listAcpSessionsByNode(
  sql: SqlStorage,
  nodeId: string,
  statuses: AcpSessionStatus[]
): AcpSession[] {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => '?').join(', ');
  const rows = sql
    .exec(
      `SELECT * FROM acp_sessions WHERE node_id = ? AND status IN (${placeholders})`,
      nodeId,
      ...statuses
    )
    .toArray();
  return rows.map((row) => parseAcpSessionRow(row));
}

/**
 * Check for stale ACP sessions whose heartbeats have expired and transition
 * them to 'interrupted'. Returns the list of workspace IDs that were affected
 * so the caller can take additional action (e.g. stopping workspaces for
 * conversation-mode sessions).
 */
export function checkHeartbeatTimeouts(
  sql: SqlStorage,
  env: Env,
  transitionFn: (sessionId: string, toStatus: AcpSessionStatus, opts: {
    actorType: AcpSessionEventActorType;
    reason?: string | null;
    errorMessage?: string;
    metadata?: Record<string, unknown> | null;
  }) => Promise<void>
): Promise<Array<{ sessionId: string; workspaceId: string | null }>> {
  const detectionWindow = parseInt(
    env.ACP_SESSION_DETECTION_WINDOW_MS || String(ACP_SESSION_DEFAULTS.DETECTION_WINDOW_MS),
    10
  );
  const cutoff = Date.now() - detectionWindow;

  const staleSessions = sql
    .exec(
      `SELECT id, chat_session_id, workspace_id, node_id, last_heartbeat_at FROM acp_sessions
       WHERE status IN ('assigned', 'running')
       AND last_heartbeat_at IS NOT NULL
       AND last_heartbeat_at < ?`,
      cutoff
    )
    .toArray()
    .map((row) => parseAcpSessionStale(row));

  const failures: Array<{ sessionId: string; error: string }> = [];
  const timedOut: Array<{ sessionId: string; workspaceId: string | null }> = [];
  const promises = staleSessions.map(async (session) => {
    try {
      await transitionFn(session.id, 'interrupted', {
        actorType: 'alarm', reason: 'Heartbeat timeout exceeded detection window',
        errorMessage: `Heartbeat timeout: last heartbeat at ${session.lastHeartbeatAt}, cutoff was ${cutoff}`,
        metadata: { detectionWindowMs: detectionWindow, lastHeartbeatAt: session.lastHeartbeatAt, cutoff },
      });
      timedOut.push({ sessionId: session.id, workspaceId: session.workspaceId });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error('acp_session.heartbeat_timeout_transition_failed', { sessionId: session.id, error: errorMsg });
      failures.push({ sessionId: session.id, error: errorMsg });
    }
  });
  return Promise.all(promises).then(() => {
    if (failures.length > 0) {
      log.error('acp_session.heartbeat_timeout_batch_failures', { failureCount: failures.length, totalStale: staleSessions.length, failures });
    }
    return timedOut;
  });
}

function recordAcpSessionEvent(sql: SqlStorage, acpSessionId: string, fromStatus: AcpSessionStatus | null, toStatus: AcpSessionStatus, actorType: AcpSessionEventActorType | string, actorId: string | null, reason: string | null, metadata: Record<string, unknown> | null = null): void {
  sql.exec(
    `INSERT INTO acp_session_events (id, acp_session_id, from_status, to_status, actor_type, actor_id, reason, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    generateId(), acpSessionId, fromStatus, toStatus, actorType, actorId, reason, metadata ? JSON.stringify(metadata) : null, Date.now()
  );
}

export function getAcpSessionOrThrow(sql: SqlStorage, sessionId: string): AcpSession {
  const row = sql
    .exec('SELECT * FROM acp_sessions WHERE id = ?', sessionId)
    .toArray()[0];
  if (!row) {
    throw new Error(`ACP session ${sessionId} not found`);
  }
  return parseAcpSessionRow(row);
}

/**
 * Compute the earliest alarm time needed for heartbeat detection.
 */
export function computeHeartbeatAlarmTime(sql: SqlStorage, env: Env): number | null {
  const detectionWindow = parseInt(
    env.ACP_SESSION_DETECTION_WINDOW_MS || String(ACP_SESSION_DEFAULTS.DETECTION_WINDOW_MS),
    10
  );

  const earliestRow = sql
    .exec(
      `SELECT MIN(last_heartbeat_at) as earliest FROM acp_sessions
       WHERE status IN ('assigned', 'running') AND last_heartbeat_at IS NOT NULL`
    )
    .toArray()[0];

  if (!earliestRow) return null;
  const earliestHeartbeat = parseMinEarliest(earliestRow, 'acp_sessions.earliest_heartbeat');
  if (earliestHeartbeat === null) return null;

  return earliestHeartbeat + detectionWindow;
}

/**
 * Update heartbeats for all active ACP sessions assigned to a given node.
 * Called during node heartbeat processing to keep sessions alive.
 * Returns the number of sessions updated.
 */
export function updateNodeHeartbeats(
  sql: SqlStorage,
  nodeId: string,
  projectId: string | null
): number {
  const now = Date.now();
  const result = sql.exec(
    `UPDATE acp_sessions SET last_heartbeat_at = ?, updated_at = ?
     WHERE node_id = ? AND status IN ('assigned', 'running')`,
    now,
    now,
    nodeId
  );
  const updated = result.rowsWritten;
  if (updated > 0) {
    log.info('acp_session.node_heartbeats_updated', {
      nodeId,
      projectId,
      sessionsUpdated: updated,
    });
  }
  return updated;
}

export function hasActiveAcpSessions(sql: SqlStorage): boolean {
  const row = sql
    .exec("SELECT COUNT(*) as cnt FROM acp_sessions WHERE status IN ('assigned', 'running')")
    .toArray()[0];
  return row ? parseCountCnt(row, 'acp_sessions.active_count') > 0 : false;
}
