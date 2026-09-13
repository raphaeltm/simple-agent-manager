import type { TerminalSessionReconciliationStats } from '../durable-objects/project-data/terminal-session-reconciliation';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { reconcileTerminalTaskSessions } from '../services/project-data';
import {
  runSessionSummaryLedgerReconciliation,
  type SessionSummaryLedgerReconciliationStats,
} from './session-summary-ledger-reconciliation';

export const DEFAULT_TERMINAL_SESSION_RECONCILE_PROJECT_BATCH_SIZE = 25;
export const MAX_TERMINAL_SESSION_RECONCILE_PROJECT_BATCH_SIZE = 200;

const CANDIDATE_PROJECTS_CTE = `
  WITH candidate_projects AS (
    SELECT
      ss.project_id AS project_id,
      MIN(COALESCE(ss.updated_at, ss.synced_at, 0)) AS oldest_active_at
    FROM session_summaries ss
    WHERE ss.status = 'active'
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
      AND NOT EXISTS (
        SELECT 1
          FROM tasks live_task
         WHERE live_task.project_id = ss.project_id
           AND live_task.chat_session_id = ss.id
           AND live_task.status NOT IN ('completed', 'failed', 'cancelled')
      )
    GROUP BY ss.project_id

    UNION

    SELECT p.id AS project_id, 0 AS oldest_active_at
      FROM projects p
     WHERE p.active_session_count > 0
       AND NOT EXISTS (
         SELECT 1
           FROM session_summaries ss
          WHERE ss.project_id = p.id
            AND ss.status = 'active'
       )
  )
`;

export interface TerminalSessionLedgerReconciliationStats {
  projectsScanned: number;
  projectsReconciled: number;
  projectErrors: number;
  selected: number;
  stopped: number;
  failed: number;
  deferred: number;
  skipped: number;
  errors: number;
  remainingCandidateProjects: number;
  summarySelected: number;
  summaryStopped: number;
  summaryFailed: number;
  summaryDeferred: number;
  summarySkipped: number;
  summaryErrors: number;
  remainingCandidateSummaries: number;
}

function projectBatchSize(env: Env): number {
  return Math.min(
    parsePositiveInt(
      env.TERMINAL_SESSION_RECONCILE_PROJECT_BATCH_SIZE,
      DEFAULT_TERMINAL_SESSION_RECONCILE_PROJECT_BATCH_SIZE
    ),
    MAX_TERMINAL_SESSION_RECONCILE_PROJECT_BATCH_SIZE
  );
}

function emptyStats(): TerminalSessionLedgerReconciliationStats {
  return {
    projectsScanned: 0,
    projectsReconciled: 0,
    projectErrors: 0,
    selected: 0,
    stopped: 0,
    failed: 0,
    deferred: 0,
    skipped: 0,
    errors: 0,
    remainingCandidateProjects: 0,
    summarySelected: 0,
    summaryStopped: 0,
    summaryFailed: 0,
    summaryDeferred: 0,
    summarySkipped: 0,
    summaryErrors: 0,
    remainingCandidateSummaries: 0,
  };
}

function addProjectStats(
  aggregate: TerminalSessionLedgerReconciliationStats,
  projectStats: TerminalSessionReconciliationStats
): void {
  aggregate.selected += projectStats.selected;
  aggregate.stopped += projectStats.stopped;
  aggregate.failed += projectStats.failed;
  aggregate.deferred += projectStats.deferred;
  aggregate.skipped += projectStats.skipped;
  aggregate.errors += projectStats.errors;
  if (projectStats.selected > 0) aggregate.projectsReconciled += 1;
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

async function candidateProjectCount(env: Env, nowMs: number): Promise<number> {
  const row = await env.DATABASE.prepare(
    `${CANDIDATE_PROJECTS_CTE}
     SELECT COUNT(*) AS count FROM candidate_projects`
  )
    .bind(nowMs)
    .first<{ count: number }>();
  return parseCount(row);
}

function addSummaryStats(
  aggregate: TerminalSessionLedgerReconciliationStats,
  summaryStats: SessionSummaryLedgerReconciliationStats
): void {
  aggregate.summarySelected += summaryStats.selected;
  aggregate.summaryStopped += summaryStats.stopped;
  aggregate.summaryFailed += summaryStats.failed;
  aggregate.summaryDeferred += summaryStats.deferred;
  aggregate.summarySkipped += summaryStats.skipped;
  aggregate.summaryErrors += summaryStats.errors;
  aggregate.remainingCandidateSummaries = summaryStats.remainingCandidates;
}

export async function runTerminalSessionLedgerReconciliation(
  env: Env,
  now: Date = new Date()
): Promise<TerminalSessionLedgerReconciliationStats> {
  const stats = emptyStats();
  const limit = projectBatchSize(env);
  const rows = await env.DATABASE.prepare(
    `${CANDIDATE_PROJECTS_CTE}
     SELECT project_id
       FROM candidate_projects
      ORDER BY oldest_active_at ASC, project_id ASC
      LIMIT ?`
  )
    .bind(now.getTime(), limit)
    .all<{ project_id: string }>();

  const projects = rows.results ?? [];
  stats.projectsScanned = projects.length;
  const summaryEligibleProjectIds: string[] = [];

  for (const row of projects) {
    const projectId = row.project_id;
    if (!projectId) {
      stats.skipped += 1;
      continue;
    }

    try {
      const projectStats = await reconcileTerminalTaskSessions(env, projectId, {
        nowIso: now.toISOString(),
      });
      addProjectStats(stats, projectStats);
      if (projectStats.errors === 0) summaryEligibleProjectIds.push(projectId);
    } catch (err) {
      stats.projectErrors += 1;
      stats.errors += 1;
      log.warn('terminal_session_ledger_reconciliation.project_failed', {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  addSummaryStats(
    stats,
    await runSessionSummaryLedgerReconciliation(env, now, {
      projectIds: summaryEligibleProjectIds,
    })
  );
  stats.remainingCandidateProjects = await candidateProjectCount(env, now.getTime());
  log.info('terminal_session_ledger_reconciliation.completed', { ...stats });
  return stats;
}
