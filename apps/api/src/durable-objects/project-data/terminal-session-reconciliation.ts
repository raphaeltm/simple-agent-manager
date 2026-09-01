/**
 * Bounded repair for ProjectData chat-session rows that stayed active after
 * their owning task reached a terminal status in D1.
 *
 * This is intentionally conservative:
 * - D1 `tasks.chat_session_id` is treated as the current conversation head.
 * - A restorable sleeping snapshot for the chat always preserves the session.
 * - Ineligible/error candidates are marked with a DO-local defer marker so a
 *   single row cannot be selected on every sweep forever.
 */
import { createModuleLogger, serializeError } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import {
  findRestorableOrInFlightSleepSnapshot,
  type SleepLifecyclePredicateResult,
} from '../../services/session-snapshot-sleep-predicate';
import type { Env } from './types';

const log = createModuleLogger('terminal_session_reconciliation');

export const DEFAULT_TERMINAL_SESSION_RECONCILE_BATCH_SIZE = 25;
export const MAX_TERMINAL_SESSION_RECONCILE_BATCH_SIZE = 200;
export const DEFAULT_TERMINAL_SESSION_RECONCILE_DEFER_MS = 60 * 60 * 1000;
export const MAX_TERMINAL_SESSION_RECONCILE_DEFER_MS = 24 * 60 * 60 * 1000;

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);

type TerminalTaskStatus = 'completed' | 'failed' | 'cancelled';
type RepairDisposition = 'stopped' | 'failed' | 'deferred' | 'skipped';

interface CandidateSession {
  id: string;
  taskId: string | null;
  workspaceId: string | null;
}

interface D1TaskRow {
  id: string;
  status: string;
  error_message: string | null;
  updated_at: string | null;
  completed_at: string | null;
}

type RestorableSnapshotRow = SleepLifecyclePredicateResult;

export interface TerminalSessionReconciliationStats {
  selected: number;
  stopped: number;
  failed: number;
  deferred: number;
  skipped: number;
  errors: number;
  remainingCandidates: number;
}

export interface TerminalSessionReconciliationInput {
  nowIso?: string;
}

export interface TerminalSessionReconciliationHooks {
  stopSession(sessionId: string): Promise<boolean>;
  failSession(sessionId: string, errorMessage: string | null): Promise<boolean>;
}

export function emptyTerminalSessionReconciliationStats(): TerminalSessionReconciliationStats {
  return {
    selected: 0,
    stopped: 0,
    failed: 0,
    deferred: 0,
    skipped: 0,
    errors: 0,
    remainingCandidates: 0,
  };
}

export function terminalSessionReconcileBatchSize(
  env: Pick<Env, 'TERMINAL_SESSION_RECONCILE_BATCH_SIZE'>
): number {
  return Math.min(
    parsePositiveInt(
      env.TERMINAL_SESSION_RECONCILE_BATCH_SIZE,
      DEFAULT_TERMINAL_SESSION_RECONCILE_BATCH_SIZE
    ),
    MAX_TERMINAL_SESSION_RECONCILE_BATCH_SIZE
  );
}

function terminalSessionReconcileDeferMs(
  env: Pick<Env, 'TERMINAL_SESSION_RECONCILE_DEFER_MS'>
): number {
  return Math.min(
    parsePositiveInt(
      env.TERMINAL_SESSION_RECONCILE_DEFER_MS,
      DEFAULT_TERMINAL_SESSION_RECONCILE_DEFER_MS
    ),
    MAX_TERMINAL_SESSION_RECONCILE_DEFER_MS
  );
}

function parseString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseCount(row: Record<string, unknown> | undefined, context: string): number {
  const value = row?.count;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  log.warn('invalid_count_row', { context, row });
  return 0;
}

function parseCandidate(row: Record<string, unknown>): CandidateSession | null {
  const id = parseString(row.id);
  if (!id) return null;
  return {
    id,
    taskId: parseString(row.task_id),
    workspaceId: parseString(row.workspace_id),
  };
}

function isTerminalTaskStatus(status: string): status is TerminalTaskStatus {
  return TERMINAL_TASK_STATUSES.has(status);
}

function deferUntil(nowMs: number, env: Env, snapshot?: RestorableSnapshotRow | null): number {
  const configuredUntil = nowMs + terminalSessionReconcileDeferMs(env);
  if (!snapshot) return configuredUntil;

  const expiresAtMs = snapshot.expires_at ? Date.parse(snapshot.expires_at) : NaN;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return configuredUntil;

  return Math.max(nowMs + 1, Math.min(configuredUntil, expiresAtMs));
}

function deferCandidate(
  sql: SqlStorage,
  sessionId: string,
  reason: string,
  untilMs: number
): boolean {
  const cursor = sql.exec(
    `UPDATE chat_sessions
        SET terminal_reconcile_deferred_until = ?,
            terminal_reconcile_defer_reason = ?
      WHERE id = ?
        AND status = 'active'`,
    untilMs,
    reason,
    sessionId
  );
  return cursor.rowsWritten > 0;
}

function readCurrentCandidate(sql: SqlStorage, sessionId: string): CandidateSession | null {
  const row = sql
    .exec(
      `SELECT id, task_id, workspace_id
         FROM chat_sessions
        WHERE id = ?
          AND status = 'active'`,
      sessionId
    )
    .toArray()[0];
  return row ? parseCandidate(row) : null;
}

async function findLiveBoundTask(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<D1TaskRow | null> {
  const row = await env.DATABASE.prepare(
    `SELECT id, status, error_message, completed_at, updated_at
       FROM tasks
      WHERE project_id = ?
        AND chat_session_id = ?
        AND status NOT IN ('completed', 'failed', 'cancelled')
      ORDER BY updated_at DESC, id DESC
      LIMIT 1`
  )
    .bind(projectId, sessionId)
    .first<D1TaskRow>();
  return row ?? null;
}

async function findTaskById(
  env: Env,
  projectId: string,
  taskId: string
): Promise<D1TaskRow | null> {
  const row = await env.DATABASE.prepare(
    `SELECT id, status, error_message, completed_at, updated_at
       FROM tasks
      WHERE project_id = ?
        AND id = ?
      LIMIT 1`
  )
    .bind(projectId, taskId)
    .first<D1TaskRow>();
  return row ?? null;
}

async function findLatestTerminalBoundTask(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<D1TaskRow | null> {
  const row = await env.DATABASE.prepare(
    `SELECT id, status, error_message, completed_at, updated_at
       FROM tasks
      WHERE project_id = ?
        AND chat_session_id = ?
        AND status IN ('completed', 'failed', 'cancelled')
      ORDER BY COALESCE(completed_at, updated_at, started_at, created_at) DESC, id DESC
      LIMIT 1`
  )
    .bind(projectId, sessionId)
    .first<D1TaskRow>();
  return row ?? null;
}

async function findRestorableSleepingSnapshot(
  env: Env,
  projectId: string,
  sessionId: string,
  now: Date
): Promise<RestorableSnapshotRow | null> {
  return findRestorableOrInFlightSleepSnapshot(env.DATABASE, env, {
    projectId,
    chatSessionId: sessionId,
    now,
  });
}

async function reconcileCandidate(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  candidate: CandidateSession,
  hooks: TerminalSessionReconciliationHooks,
  now: Date
): Promise<RepairDisposition> {
  const current = readCurrentCandidate(sql, candidate.id);
  if (!current) return 'skipped';

  const liveBoundTask = await findLiveBoundTask(env, projectId, current.id);
  if (liveBoundTask) {
    return deferCandidate(sql, current.id, 'live_task_head', deferUntil(now.getTime(), env))
      ? 'deferred'
      : 'skipped';
  }

  const explicitTask = current.taskId ? await findTaskById(env, projectId, current.taskId) : null;
  if (explicitTask && !isTerminalTaskStatus(explicitTask.status)) {
    return deferCandidate(
      sql,
      current.id,
      'owning_task_nonterminal',
      deferUntil(now.getTime(), env)
    )
      ? 'deferred'
      : 'skipped';
  }

  const boundTerminalTask = await findLatestTerminalBoundTask(env, projectId, current.id);
  const ownerTask =
    boundTerminalTask ??
    (explicitTask && isTerminalTaskStatus(explicitTask.status) ? explicitTask : null);
  if (!ownerTask || !isTerminalTaskStatus(ownerTask.status)) {
    return deferCandidate(sql, current.id, 'terminal_owner_missing', deferUntil(now.getTime(), env))
      ? 'deferred'
      : 'skipped';
  }

  // Mirrors the shared destroyer guard in
  // `findRestorableOrInFlightSleepSnapshot`: fully restorable sleeping
  // snapshots and bounded in-flight sleep lifecycles must not be archived by
  // terminal-task reconciliation.
  const snapshot = await findRestorableSleepingSnapshot(env, projectId, current.id, now);
  if (snapshot) {
    return deferCandidate(
      sql,
      current.id,
      `sleep_lifecycle_${snapshot.sleep_status ?? 'unknown'}`,
      deferUntil(now.getTime(), env, snapshot)
    )
      ? 'deferred'
      : 'skipped';
  }

  if (ownerTask.status === 'failed') {
    const failed = await hooks.failSession(
      current.id,
      ownerTask.error_message ?? 'Owning task reached failed status'
    );
    return failed ? 'failed' : 'skipped';
  }

  const stopped = await hooks.stopSession(current.id);
  return stopped ? 'stopped' : 'skipped';
}

export async function reconcileTerminalTaskSessions(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  hooks: TerminalSessionReconciliationHooks,
  input: TerminalSessionReconciliationInput = {}
): Promise<TerminalSessionReconciliationStats> {
  const parsedNow = input.nowIso ? new Date(input.nowIso) : new Date();
  const now = Number.isFinite(parsedNow.getTime()) ? parsedNow : new Date();
  const limit = terminalSessionReconcileBatchSize(env);
  const stats = emptyTerminalSessionReconciliationStats();

  const rows = sql
    .exec(
      `SELECT id, task_id, workspace_id
         FROM chat_sessions
        WHERE status = 'active'
          AND (
            terminal_reconcile_deferred_until IS NULL
            OR terminal_reconcile_deferred_until <= ?
          )
        ORDER BY updated_at ASC, id ASC
        LIMIT ?`,
      now.getTime(),
      limit
    )
    .toArray();
  stats.selected = rows.length;

  for (const row of rows) {
    const candidate = parseCandidate(row);
    if (!candidate) {
      stats.skipped += 1;
      continue;
    }

    try {
      const disposition = await reconcileCandidate(sql, env, projectId, candidate, hooks, now);
      if (disposition === 'stopped') stats.stopped += 1;
      else if (disposition === 'failed') stats.failed += 1;
      else if (disposition === 'deferred') stats.deferred += 1;
      else stats.skipped += 1;
    } catch (err) {
      stats.errors += 1;
      try {
        if (deferCandidate(sql, candidate.id, 'repair_error', deferUntil(now.getTime(), env))) {
          stats.deferred += 1;
        }
      } catch (deferErr) {
        log.error('candidate_defer_failed', {
          projectId,
          sessionId: candidate.id,
          ...serializeError(deferErr),
        });
      }
      log.warn('candidate_repair_failed', {
        projectId,
        sessionId: candidate.id,
        taskId: candidate.taskId,
        workspaceId: candidate.workspaceId,
        ...serializeError(err),
      });
    }
  }

  const remainingRow = sql
    .exec(
      `SELECT COUNT(*) AS count
         FROM chat_sessions
        WHERE status = 'active'
          AND (
            terminal_reconcile_deferred_until IS NULL
            OR terminal_reconcile_deferred_until <= ?
          )`,
      now.getTime()
    )
    .toArray()[0];
  stats.remainingCandidates = parseCount(remainingRow, 'terminal_session_reconciliation.remaining');

  log.info('completed', { projectId, ...stats });
  return stats;
}
