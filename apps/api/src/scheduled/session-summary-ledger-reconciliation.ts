/**
 * Bounded D1 repair for `session_summaries` rows that still say `active` after
 * their owning task is terminal.
 *
 * ProjectData DO rows remain authoritative for the project active-session
 * aggregate. This sweep only repairs the D1 read index for projects whose
 * session index is intentionally over-cap and therefore no longer receives
 * row-level summary syncs.
 */
import {
  DEFAULT_TERMINAL_SESSION_RECONCILE_DEFER_MS,
  MAX_TERMINAL_SESSION_RECONCILE_DEFER_MS,
} from '../durable-objects/project-data/terminal-session-reconciliation';
import type { Env } from '../env';
import { createModuleLogger, serializeError } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS } from '../services/session-snapshot-artifacts';

const log = createModuleLogger('session_summary_ledger_reconciliation');

export const DEFAULT_TERMINAL_SESSION_SUMMARY_RECONCILE_BATCH_SIZE = 25;
export const MAX_TERMINAL_SESSION_SUMMARY_RECONCILE_BATCH_SIZE = 200;

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);

type TerminalTaskStatus = 'completed' | 'failed' | 'cancelled';
type SummaryDisposition = 'stopped' | 'failed' | 'deferred' | 'skipped';

interface SummaryCandidate {
  id: string;
  projectId: string;
  taskId: string | null;
}

interface D1TaskRow {
  id: string;
  status: string;
  error_message: string | null;
  updated_at: string | null;
  completed_at: string | null;
}

interface RestorableSnapshotRow {
  expires_at: string;
}

export interface SessionSummaryLedgerReconciliationStats {
  selected: number;
  stopped: number;
  failed: number;
  deferred: number;
  skipped: number;
  errors: number;
  remainingCandidates: number;
}

export interface SessionSummaryLedgerReconciliationOptions {
  projectIds?: string[];
}

function emptyStats(): SessionSummaryLedgerReconciliationStats {
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

export function terminalSessionSummaryReconcileBatchSize(
  env: Pick<Env, 'TERMINAL_SESSION_SUMMARY_RECONCILE_BATCH_SIZE'>
): number {
  return Math.min(
    parsePositiveInt(
      env.TERMINAL_SESSION_SUMMARY_RECONCILE_BATCH_SIZE,
      DEFAULT_TERMINAL_SESSION_SUMMARY_RECONCILE_BATCH_SIZE
    ),
    MAX_TERMINAL_SESSION_SUMMARY_RECONCILE_BATCH_SIZE
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

function snapshotRecoveryMaxAttempts(
  env: Pick<Env, 'SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS'>
): number {
  return parsePositiveInt(
    env.SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS,
    DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS
  );
}

function parseString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseCount(row: { count?: unknown } | null): number {
  const value = row?.count;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function parseCandidate(row: Record<string, unknown>): SummaryCandidate | null {
  const id = parseString(row.id);
  const projectId = parseString(row.project_id);
  if (!id || !projectId) return null;
  return {
    id,
    projectId,
    taskId: parseString(row.task_id),
  };
}

function isTerminalTaskStatus(status: string): status is TerminalTaskStatus {
  return TERMINAL_TASK_STATUSES.has(status);
}

function deferUntil(nowMs: number, env: Env, snapshot?: RestorableSnapshotRow | null): number {
  const configuredUntil = nowMs + terminalSessionReconcileDeferMs(env);
  if (!snapshot) return configuredUntil;

  const expiresAtMs = Date.parse(snapshot.expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return configuredUntil;

  return Math.max(nowMs + 1, Math.min(configuredUntil, expiresAtMs));
}

async function deferCandidate(
  env: Env,
  candidate: SummaryCandidate,
  reason: string,
  untilMs: number
): Promise<boolean> {
  const result = await env.DATABASE.prepare(
    `UPDATE session_summaries
        SET terminal_reconcile_deferred_until = ?,
            terminal_reconcile_defer_reason = ?
      WHERE id = ?
        AND project_id = ?
        AND status = 'active'`
  )
    .bind(untilMs, reason, candidate.id, candidate.projectId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

async function isStillActive(env: Env, candidate: SummaryCandidate): Promise<boolean> {
  const row = await env.DATABASE.prepare(
    `SELECT 1 AS present
       FROM session_summaries
      WHERE id = ?
        AND project_id = ?
        AND status = 'active'
      LIMIT 1`
  )
    .bind(candidate.id, candidate.projectId)
    .first<{ present: number }>();
  return row?.present === 1;
}

async function findLiveBoundTask(env: Env, candidate: SummaryCandidate): Promise<D1TaskRow | null> {
  const row = await env.DATABASE.prepare(
    `SELECT id, status, error_message, completed_at, updated_at
      FROM tasks
      WHERE project_id = ?
        AND chat_session_id = ?
        AND status NOT IN ('completed', 'failed', 'cancelled')
      ORDER BY updated_at DESC, id DESC
      LIMIT 1`
  )
    .bind(candidate.projectId, candidate.id)
    .first<D1TaskRow>();
  return row ?? null;
}

async function findTaskById(
  env: Env,
  candidate: SummaryCandidate,
  taskId: string
): Promise<D1TaskRow | null> {
  const row = await env.DATABASE.prepare(
    `SELECT id, status, error_message, completed_at, updated_at
       FROM tasks
      WHERE project_id = ?
        AND id = ?
      LIMIT 1`
  )
    .bind(candidate.projectId, taskId)
    .first<D1TaskRow>();
  return row ?? null;
}

async function findLatestTerminalBoundTask(
  env: Env,
  candidate: SummaryCandidate
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
    .bind(candidate.projectId, candidate.id)
    .first<D1TaskRow>();
  return row ?? null;
}

async function findRestorableSleepingSnapshot(
  env: Env,
  candidate: SummaryCandidate,
  now: Date
): Promise<RestorableSnapshotRow | null> {
  const row = await env.DATABASE.prepare(
    `SELECT expires_at
      FROM session_snapshots
      WHERE chat_session_id = ?
        AND project_id = ?
        AND sleeping_at IS NOT NULL
        AND sleep_status = 'sleeping'
        AND expires_at > ?
        AND recovery_attempts < ?
        AND (
          (status = 'available' AND degradation = 'none')
          OR (status = 'degraded' AND degradation IS NOT NULL AND degradation != 'none')
        )
      ORDER BY expires_at ASC
      LIMIT 1`
  )
    .bind(candidate.id, candidate.projectId, now.toISOString(), snapshotRecoveryMaxAttempts(env))
    .first<RestorableSnapshotRow>();
  return row ?? null;
}

function terminalTimestampMs(task: D1TaskRow, nowMs: number): number {
  const parsed = Date.parse(task.completed_at ?? task.updated_at ?? '');
  return Number.isFinite(parsed) ? parsed : nowMs;
}

async function terminalizeSummary(
  env: Env,
  candidate: SummaryCandidate,
  ownerTask: D1TaskRow,
  now: Date
): Promise<boolean> {
  const nowMs = now.getTime();
  const terminalMs = terminalTimestampMs(ownerTask, nowMs);
  const status = ownerTask.status === 'failed' ? 'failed' : 'stopped';
  const result = await env.DATABASE.prepare(
    `UPDATE session_summaries
        SET status = ?,
            ended_at = COALESCE(ended_at, ?),
            agent_completed_at = COALESCE(agent_completed_at, ?),
            updated_at = ?,
            synced_at = ?,
            terminal_reconcile_deferred_until = NULL,
            terminal_reconcile_defer_reason = NULL
      WHERE id = ?
        AND project_id = ?
        AND status = 'active'
        AND NOT EXISTS (
          SELECT 1
            FROM tasks live_task
           WHERE live_task.project_id = session_summaries.project_id
             AND live_task.chat_session_id = session_summaries.id
             AND live_task.status NOT IN ('completed', 'failed', 'cancelled')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM session_snapshots snapshot
           WHERE snapshot.chat_session_id = session_summaries.id
             AND snapshot.project_id = session_summaries.project_id
             AND snapshot.sleeping_at IS NOT NULL
             AND snapshot.sleep_status = 'sleeping'
             AND snapshot.expires_at > ?
             AND snapshot.recovery_attempts < ?
             AND (
               (snapshot.status = 'available' AND snapshot.degradation = 'none')
               OR (
                 snapshot.status = 'degraded'
                 AND snapshot.degradation IS NOT NULL
                 AND snapshot.degradation != 'none'
               )
             )
        )`
  )
    .bind(
      status,
      terminalMs,
      terminalMs,
      nowMs,
      nowMs,
      candidate.id,
      candidate.projectId,
      now.toISOString(),
      snapshotRecoveryMaxAttempts(env)
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

async function reconcileCandidate(
  env: Env,
  candidate: SummaryCandidate,
  now: Date
): Promise<SummaryDisposition> {
  if (!(await isStillActive(env, candidate))) return 'skipped';

  const liveBoundTask = await findLiveBoundTask(env, candidate);
  if (liveBoundTask) {
    return (await deferCandidate(env, candidate, 'live_task_head', deferUntil(now.getTime(), env)))
      ? 'deferred'
      : 'skipped';
  }

  const explicitTask = candidate.taskId
    ? await findTaskById(env, candidate, candidate.taskId)
    : null;
  if (explicitTask && !isTerminalTaskStatus(explicitTask.status)) {
    return (await deferCandidate(
      env,
      candidate,
      'owning_task_nonterminal',
      deferUntil(now.getTime(), env)
    ))
      ? 'deferred'
      : 'skipped';
  }

  const boundTerminalTask = await findLatestTerminalBoundTask(env, candidate);
  const ownerTask =
    boundTerminalTask ??
    (explicitTask && isTerminalTaskStatus(explicitTask.status) ? explicitTask : null);
  if (!ownerTask || !isTerminalTaskStatus(ownerTask.status)) {
    return (await deferCandidate(
      env,
      candidate,
      'terminal_owner_missing',
      deferUntil(now.getTime(), env)
    ))
      ? 'deferred'
      : 'skipped';
  }

  const snapshot = await findRestorableSleepingSnapshot(env, candidate, now);
  if (snapshot) {
    return (await deferCandidate(
      env,
      candidate,
      'restorable_sleeping_snapshot',
      deferUntil(now.getTime(), env, snapshot)
    ))
      ? 'deferred'
      : 'skipped';
  }

  if (await terminalizeSummary(env, candidate, ownerTask, now)) {
    return ownerTask.status === 'failed' ? 'failed' : 'stopped';
  }

  if (!(await isStillActive(env, candidate))) return 'skipped';
  return (await deferCandidate(
    env,
    candidate,
    'concurrent_guard_changed',
    deferUntil(now.getTime(), env)
  ))
    ? 'deferred'
    : 'skipped';
}

const SUMMARY_CANDIDATE_EXISTS_SQL = `
  ss.status = 'active'
  AND (
    ss.terminal_reconcile_deferred_until IS NULL
    OR ss.terminal_reconcile_deferred_until <= ?
  )
  AND (
    EXISTS (
      SELECT 1
        FROM tasks terminal_task
       WHERE terminal_task.project_id = ss.project_id
         AND terminal_task.id = ss.task_id
         AND terminal_task.status IN ('completed', 'failed', 'cancelled')
    )
    OR EXISTS (
      SELECT 1
        FROM tasks terminal_bound_task
       WHERE terminal_bound_task.project_id = ss.project_id
         AND terminal_bound_task.chat_session_id = ss.id
         AND terminal_bound_task.status IN ('completed', 'failed', 'cancelled')
    )
  )
`;

function normalizeProjectIds(projectIds: string[] | undefined): string[] | null {
  if (!projectIds) return null;
  return [...new Set(projectIds.filter((projectId) => projectId.length > 0))];
}

function projectFilter(projectIds: string[] | null): { sql: string; params: string[] } {
  if (!projectIds) return { sql: '', params: [] };
  if (projectIds.length === 0) return { sql: 'AND 1 = 0', params: [] };
  return {
    sql: `AND ss.project_id IN (${projectIds.map(() => '?').join(', ')})`,
    params: projectIds,
  };
}

async function remainingCandidateCount(
  env: Env,
  nowMs: number,
  projectIds: string[] | null
): Promise<number> {
  const filter = projectFilter(projectIds);
  const row = await env.DATABASE.prepare(
    `SELECT COUNT(*) AS count
       FROM session_summaries ss
      WHERE ${SUMMARY_CANDIDATE_EXISTS_SQL}
        ${filter.sql}`
  )
    .bind(nowMs, ...filter.params)
    .first<{ count: number }>();
  return parseCount(row);
}

export async function runSessionSummaryLedgerReconciliation(
  env: Env,
  now: Date = new Date(),
  options: SessionSummaryLedgerReconciliationOptions = {}
): Promise<SessionSummaryLedgerReconciliationStats> {
  const stats = emptyStats();
  const nowMs = now.getTime();
  const scopedProjectIds = normalizeProjectIds(options.projectIds);
  const filter = projectFilter(scopedProjectIds);
  const rows = await env.DATABASE.prepare(
    `SELECT ss.id, ss.project_id, ss.task_id
       FROM session_summaries ss
      WHERE ${SUMMARY_CANDIDATE_EXISTS_SQL}
        ${filter.sql}
      ORDER BY COALESCE(ss.updated_at, ss.synced_at, 0) ASC, ss.id ASC
      LIMIT ?`
  )
    .bind(nowMs, ...filter.params, terminalSessionSummaryReconcileBatchSize(env))
    .all<Record<string, unknown>>();

  const candidates = rows.results ?? [];
  stats.selected = candidates.length;

  for (const row of candidates) {
    const candidate = parseCandidate(row);
    if (!candidate) {
      stats.skipped += 1;
      continue;
    }

    try {
      const disposition = await reconcileCandidate(env, candidate, now);
      if (disposition === 'stopped') stats.stopped += 1;
      else if (disposition === 'failed') stats.failed += 1;
      else if (disposition === 'deferred') stats.deferred += 1;
      else stats.skipped += 1;
    } catch (err) {
      stats.errors += 1;
      try {
        if (await deferCandidate(env, candidate, 'repair_error', deferUntil(now.getTime(), env))) {
          stats.deferred += 1;
        }
      } catch (deferErr) {
        log.error('candidate_defer_failed', {
          projectId: candidate.projectId,
          chatSessionId: candidate.id,
          ...serializeError(deferErr),
        });
      }
      log.warn('candidate_repair_failed', {
        projectId: candidate.projectId,
        chatSessionId: candidate.id,
        taskId: candidate.taskId,
        ...serializeError(err),
      });
    }
  }

  stats.remainingCandidates = await remainingCandidateCount(env, nowMs, scopedProjectIds);
  log.info('completed', { ...stats });
  return stats;
}
