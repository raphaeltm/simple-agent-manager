/**
 * Chat session creation and state machine. Listing and lookups live in `session-reads.ts`.
 */
import { clearWorkspaceIdleCheck } from './activity';
import { parseCountCnt, parseSessionStatus, parseSessionStop } from './row-schemas';
import type { Env } from './types';
import { generateId } from './types';

export type ReservedTaskSessionConflictReason =
  | 'session_identity_conflict'
  | 'session_terminal'
  | 'session_capacity_exceeded';

export class ReservedTaskSessionConflictError extends Error {
  constructor(
    readonly reason: ReservedTaskSessionConflictReason,
    message: string
  ) {
    super(message);
    this.name = 'ReservedTaskSessionConflictError';
  }
}

export interface CreateReservedTaskSessionInput {
  sessionId: string;
  workspaceId: string | null;
  topic: string | null;
  taskId: string;
  createdByUserId: string | null;
}

export interface CreateReservedTaskSessionResult {
  id: string;
  now: number;
  inserted: boolean;
}

export interface SessionIdentityGuard {
  taskId?: string | null;
  createdByUserId?: string | null;
  workspaceId?: string | null;
}

export interface CreateReservedTaskSessionWithInitialMessageInput extends CreateReservedTaskSessionInput {
  initialMessageId: string;
  initialMessageRole: string;
  initialMessageContent: string;
  initialMessageToolMetadata: string | null;
}

export type CreateReservedTaskSessionWithInitialMessageResult =
  | {
      outcome: 'created';
      sessionId: string;
      initialMessageId: string;
      sessionInserted: boolean;
      initialMessageInserted: boolean;
    }
  | {
      outcome: 'conflict';
      reason: ReservedTaskSessionConflictReason | 'initial_message_conflict';
      message: string;
    };

function readReservedSession(sql: SqlStorage, sessionId: string): Record<string, unknown> | null {
  return (
    sql
      .exec(
        `SELECT id, workspace_id, task_id, created_by_user_id, topic, status, updated_at
         FROM chat_sessions WHERE id = ? LIMIT 1`,
        sessionId
      )
      .toArray()[0] ?? null
  );
}

function readSessionForGuard(sql: SqlStorage, sessionId: string): Record<string, unknown> | null {
  return (
    sql
      .exec(
        `SELECT id, workspace_id, task_id, created_by_user_id, status, message_count
           FROM chat_sessions WHERE id = ? LIMIT 1`,
        sessionId
      )
      .toArray()[0] ?? null
  );
}

function guardHasField(guard: SessionIdentityGuard, field: keyof SessionIdentityGuard): boolean {
  return Object.prototype.hasOwnProperty.call(guard, field);
}

function guardFieldValue(
  guard: SessionIdentityGuard,
  field: keyof SessionIdentityGuard,
  sessionId: string,
  operation: string
): string | null | undefined {
  if (!guardHasField(guard, field)) return undefined;
  const value = guard[field];
  if (typeof value === 'string' || value === null) return value;
  throw new Error(`Session ${sessionId} ${operation} guard has invalid ${field}: ${typeof value}`);
}

function assertGuardField(
  row: Record<string, unknown>,
  field: string,
  expected: string | null | undefined,
  sessionId: string,
  operation: string
): void {
  if (expected === undefined) return;
  if (row[field] === expected) return;
  throw new Error(
    `Session ${sessionId} cannot ${operation}: expected ${field} ${expected ?? 'null'}`
  );
}

export function assertSessionIdentityGuard(
  sql: SqlStorage,
  sessionId: string,
  operation: string,
  guard?: SessionIdentityGuard | null,
  options: { allowNullWorkspace?: boolean } = {}
): Record<string, unknown> | null {
  if (!guard) return null;
  const row = readSessionForGuard(sql, sessionId);
  if (!row) {
    throw new Error(`Session ${sessionId} not found`);
  }

  assertGuardField(
    row,
    'task_id',
    guardFieldValue(guard, 'taskId', sessionId, operation),
    sessionId,
    operation
  );
  assertGuardField(
    row,
    'created_by_user_id',
    guardFieldValue(guard, 'createdByUserId', sessionId, operation),
    sessionId,
    operation
  );
  const expectedWorkspaceId = guardFieldValue(guard, 'workspaceId', sessionId, operation);
  if (
    expectedWorkspaceId !== undefined &&
    row.workspace_id !== expectedWorkspaceId &&
    !(options.allowNullWorkspace && row.workspace_id === null)
  ) {
    throw new Error(
      `Session ${sessionId} cannot ${operation}: expected workspace_id ${expectedWorkspaceId ?? 'null'}`
    );
  }
  return row;
}

function assertReservedSessionMatches(
  row: Record<string, unknown>,
  input: CreateReservedTaskSessionInput
): number {
  const status = typeof row.status === 'string' ? row.status : null;
  if (status === 'stopped' || status === 'failed') {
    throw new ReservedTaskSessionConflictError(
      'session_terminal',
      `Session ${input.sessionId} is ${status} and cannot be reused for reserved task submission`
    );
  }
  if (
    row.task_id !== input.taskId ||
    row.created_by_user_id !== input.createdByUserId ||
    row.topic !== input.topic ||
    (input.workspaceId !== null && row.workspace_id !== input.workspaceId)
  ) {
    throw new ReservedTaskSessionConflictError(
      'session_identity_conflict',
      `Session ${input.sessionId} already belongs to a different task submission`
    );
  }
  return typeof row.updated_at === 'number' ? row.updated_at : Date.now();
}

export function createSession(
  sql: SqlStorage,
  env: Env,
  workspaceId: string | null,
  topic: string | null,
  taskId: string | null = null,
  createdByUserId: string | null = null
): { id: string; now: number } {
  const maxSessions = parseInt(env.MAX_SESSIONS_PER_PROJECT || '10000', 10);
  const countRow = sql.exec('SELECT COUNT(*) as cnt FROM chat_sessions').toArray()[0];
  if (countRow && parseCountCnt(countRow, 'sessions.create_count') >= maxSessions) {
    throw new Error(`Maximum ${maxSessions} sessions per project exceeded`);
  }

  const id = generateId();
  const now = Date.now();
  sql.exec(
    `INSERT INTO chat_sessions (id, workspace_id, task_id, created_by_user_id, topic, status, message_count, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)`,
    id,
    workspaceId,
    taskId,
    createdByUserId,
    topic,
    now,
    now,
    now
  );

  // Initialize workspace activity tracking for idle detection
  if (workspaceId) {
    sql.exec(
      `INSERT OR IGNORE INTO workspace_activity (workspace_id, session_id, last_message_at, created_at)
       VALUES (?, ?, ?, ?)`,
      workspaceId,
      id,
      now,
      now
    );
  }

  return { id, now };
}

export function createReservedTaskSession(
  sql: SqlStorage,
  env: Env,
  input: CreateReservedTaskSessionInput
): CreateReservedTaskSessionResult {
  const existing = readReservedSession(sql, input.sessionId);
  if (existing) {
    return {
      id: input.sessionId,
      now: assertReservedSessionMatches(existing, input),
      inserted: false,
    };
  }

  const maxSessions = parseInt(env.MAX_SESSIONS_PER_PROJECT || '10000', 10);
  const countRow = sql.exec('SELECT COUNT(*) as cnt FROM chat_sessions').toArray()[0];
  if (countRow && parseCountCnt(countRow, 'sessions.create_reserved_count') >= maxSessions) {
    throw new ReservedTaskSessionConflictError(
      'session_capacity_exceeded',
      `Maximum ${maxSessions} sessions per project exceeded`
    );
  }

  const now = Date.now();
  sql.exec(
    `INSERT INTO chat_sessions (id, workspace_id, task_id, created_by_user_id, topic, status, message_count, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)`,
    input.sessionId,
    input.workspaceId,
    input.taskId,
    input.createdByUserId,
    input.topic,
    now,
    now,
    now
  );

  if (input.workspaceId) {
    sql.exec(
      `INSERT OR IGNORE INTO workspace_activity (workspace_id, session_id, last_message_at, created_at)
       VALUES (?, ?, ?, ?)`,
      input.workspaceId,
      input.sessionId,
      now,
      now
    );
  }

  return { id: input.sessionId, now, inserted: true };
}

export function linkSessionToTask(sql: SqlStorage, sessionId: string, taskId: string): boolean {
  const cursor = sql.exec(
    'UPDATE chat_sessions SET task_id = ?, updated_at = ? WHERE id = ? AND (task_id IS NULL OR task_id = ?)',
    taskId,
    Date.now(),
    sessionId,
    taskId
  );
  return cursor.rowsWritten > 0;
}

function terminateSession(
  sql: SqlStorage,
  sessionId: string,
  terminalStatus: 'stopped' | 'failed',
  guard?: SessionIdentityGuard | null
): { workspaceId: string | null; messageCount: number; rowsWritten: number } | null {
  const now = Date.now();
  assertSessionIdentityGuard(sql, sessionId, terminalStatus, guard);
  const cursor = sql.exec(
    `UPDATE chat_sessions SET status = ?, ended_at = ?, updated_at = ? WHERE id = ? AND status IN ('active', 'sleeping')`,
    terminalStatus,
    now,
    now,
    sessionId
  );

  const row = sql
    .exec('SELECT workspace_id, message_count FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];

  if (!row) return null;
  return { ...parseSessionStop(row), rowsWritten: cursor.rowsWritten };
}

export function sleepSession(sql: SqlStorage, sessionId: string): boolean {
  const now = Date.now();
  const cursor = sql.exec(
    `UPDATE chat_sessions SET status = 'sleeping', ended_at = NULL, updated_at = ?
     WHERE id = ? AND status = 'active'`,
    now,
    sessionId
  );
  return cursor.rowsWritten > 0;
}

export interface WakeSessionOptions {
  allowStopped?: boolean;
}

export function wakeSession(
  sql: SqlStorage,
  sessionId: string,
  workspaceId: string,
  taskId: string,
  options: WakeSessionOptions = {}
): boolean {
  const now = Date.now();
  const cursor = sql.exec(
    `UPDATE chat_sessions
     SET status = 'active', workspace_id = ?, task_id = ?, ended_at = NULL,
         agent_completed_at = NULL, updated_at = ?
     WHERE id = ? AND (
       status = 'sleeping' OR (status IN ('active', 'failed') AND workspace_id = ?)
       OR (? = 1 AND status = 'stopped')
     )`,
    workspaceId,
    taskId,
    now,
    sessionId,
    workspaceId,
    options.allowStopped ? 1 : 0
  );
  if (cursor.rowsWritten === 0) return false;
  clearWorkspaceIdleCheck(sql, workspaceId, sessionId);
  return true;
}

export function stopSession(
  sql: SqlStorage,
  sessionId: string,
  guard?: SessionIdentityGuard | null
): { workspaceId: string | null; messageCount: number } | null {
  const result = terminateSession(sql, sessionId, 'stopped', guard);
  // If no rows were updated, session was already stopped/failed — skip
  if (!result || result.rowsWritten === 0) return null;
  return result;
}

export function stopSessionInternal(sql: SqlStorage, sessionId: string): void {
  terminateSession(sql, sessionId, 'stopped');
}

export function failSession(
  sql: SqlStorage,
  sessionId: string,
  guard?: SessionIdentityGuard | null
): { workspaceId: string | null; messageCount: number } | null {
  const result = terminateSession(sql, sessionId, 'failed', guard);
  // If no rows were updated, session was already stopped/failed — skip
  if (!result || result.rowsWritten === 0) return null;
  return result;
}

export function linkSessionToWorkspace(
  sql: SqlStorage,
  sessionId: string,
  workspaceId: string,
  guard?: SessionIdentityGuard | null
): void {
  const session =
    assertSessionIdentityGuard(sql, sessionId, 'link workspace', guard, {
      allowNullWorkspace: true,
    }) ?? readSessionForGuard(sql, sessionId);

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }
  const status = typeof session.status === 'string' ? session.status : null;
  if (status !== 'active' && status !== 'sleeping') {
    throw new Error(`Session ${sessionId} is ${status ?? 'unknown'} and cannot be linked`);
  }

  const now = Date.now();
  sql.exec(
    `UPDATE chat_sessions
        SET workspace_id = ?, updated_at = ?
      WHERE id = ?
        AND status IN ('active', 'sleeping')`,
    workspaceId,
    now,
    sessionId
  );

  // Initialize workspace activity tracking for idle detection.
  sql.exec(
    `INSERT OR IGNORE INTO workspace_activity (workspace_id, session_id, last_message_at, created_at)
     VALUES (?, ?, ?, ?)`,
    workspaceId,
    sessionId,
    now,
    now
  );
}

export function updateSessionTopic(sql: SqlStorage, sessionId: string, topic: string): boolean {
  const row = sql.exec('SELECT id, status FROM chat_sessions WHERE id = ?', sessionId).toArray()[0];

  if (!row) return false;
  const session = parseSessionStatus(row);
  if (session.status !== 'active') return false;

  const now = Date.now();
  sql.exec(
    'UPDATE chat_sessions SET topic = ?, updated_at = ? WHERE id = ?',
    topic,
    now,
    sessionId
  );
  return true;
}

export function markAgentCompleted(sql: SqlStorage, sessionId: string): number {
  const now = Date.now();
  sql.exec(
    `UPDATE chat_sessions SET agent_completed_at = ?, updated_at = ? WHERE id = ? AND agent_completed_at IS NULL`,
    now,
    now,
    sessionId
  );
  return now;
}
