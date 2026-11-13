/**
 * When a workspace in 'creating' has run out of time. One rule, shared by the TaskRunner's
 * workspace_ready step, the provisioning-timeout cron and the stuck-task sweep.
 *
 * A node builds one workspace at a time, so 'creating' has two phases:
 *   queued    the reservation exists, waiting for the node's build slot
 *   building  the VM agent took the slot (`build_started_at`, written by the build-started
 *             callback, first write wins)
 * A queued attempt may wait up to the queue budget from the start of the attempt
 * (`creating_started_at`). Once the build starts it has the build budget from that moment, so
 * time spent queued never eats into the build. A build that starts just inside the queue budget
 * still gets its full build budget.
 *
 * Before the build starts, the attempt has the larger of the two budgets. That is the queue
 * budget at the defaults; it only differs when an operator configures a build budget longer than
 * the queue budget, and then it keeps the build budget from being shortened for workspaces that
 * never report a build start. Those are direct creates (the callback is task-scoped): for them
 * the queued deadline is a total budget for the whole attempt, not evidence of a real queue wait.
 * Rows from before migration 0229 have neither column and fall back to `created_at`, which is
 * what every reader used before.
 *
 * Throughput at the default 60-minute queue budget: about 20 queued builds of ~3 minutes on one
 * node before the last one times out. Ranking spreads a burst across nodes first.
 */
import { DEFAULT_WORKSPACE_BUILD_QUEUE_TIMEOUT_MINUTES } from '@simple-agent-manager/scheduler-core';

import type { Env } from '../env';
import { resolveAdminSetting } from './admin-settings-resolution';

export interface WorkspaceCreatingClock {
  createdAt: string;
  creatingStartedAt: string | null;
  buildStartedAt: string | null;
}

export interface WorkspaceCreatingBudgets {
  /** How long an attempt may wait for its build to start (at least `buildMs`, see above). */
  queueWaitMs: number;
  /** How long a started build may take to become ready. */
  buildMs: number;
}

export type WorkspaceCreatingPhase = 'queued' | 'building';

export interface WorkspaceCreatingDeadline {
  phase: WorkspaceCreatingPhase;
  /** The timestamp the deadline is measured from. */
  anchor: string;
  deadlineMs: number;
}

/**
 * Parse a stored timestamp the way SQLite's julianday() does: ISO 8601, or the
 * `YYYY-MM-DD HH:MM:SS` form `CURRENT_TIMESTAMP` writes, which SQLite reads as UTC.
 */
function parseStoredTimestamp(value: string): number {
  const sqliteDefault = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(value);
  return Date.parse(sqliteDefault ? `${sqliteDefault[1]}T${sqliteDefault[2]}Z` : value);
}

export function workspaceCreatingDeadline(
  clock: WorkspaceCreatingClock,
  budgets: WorkspaceCreatingBudgets
): WorkspaceCreatingDeadline {
  if (clock.buildStartedAt) {
    return {
      phase: 'building',
      anchor: clock.buildStartedAt,
      deadlineMs: parseStoredTimestamp(clock.buildStartedAt) + budgets.buildMs,
    };
  }
  const anchor = clock.creatingStartedAt ?? clock.createdAt;
  return {
    phase: 'queued',
    anchor,
    deadlineMs: parseStoredTimestamp(anchor) + queuedBudgetMs(budgets),
  };
}

/**
 * True when the deadline has passed. An unparseable anchor counts as overdue: a row whose clock
 * cannot be read must not wait forever.
 */
function queuedBudgetMs(budgets: WorkspaceCreatingBudgets): number {
  return Math.max(budgets.queueWaitMs, budgets.buildMs);
}

export function isWorkspaceCreatingOverdue(
  clock: WorkspaceCreatingClock,
  budgets: WorkspaceCreatingBudgets,
  nowMs: number
): boolean {
  const { deadlineMs } = workspaceCreatingDeadline(clock, budgets);
  return !Number.isFinite(deadlineMs) || nowMs > deadlineMs;
}

/**
 * The same rule as `isWorkspaceCreatingOverdue`, for a SQL predicate over workspace alias
 * `alias`. Binds, in order: now (ISO), build budget ms, now (ISO), queued budget ms.
 */
export function workspaceCreatingOverdueSql(
  alias: string,
  nowIso: string,
  budgets: WorkspaceCreatingBudgets
): { sql: string; binds: Array<string | number> } {
  return {
    // ROUND: julianday() is a double, so the raw difference lands a fraction of a millisecond
    // off and the boundary would disagree with the JS rule. COALESCE(..., 1): an unparseable
    // timestamp makes julianday() NULL; count it as overdue, as the JS rule does.
    sql: `(CASE
        WHEN ${alias}.build_started_at IS NOT NULL
          THEN COALESCE(ROUND((julianday(?) - julianday(${alias}.build_started_at)) * 86400000) > ?, 1)
        ELSE COALESCE(ROUND((julianday(?) - julianday(COALESCE(${alias}.creating_started_at, ${alias}.created_at))) * 86400000) > ?, 1)
      END) = 1`,
    binds: [nowIso, budgets.buildMs, nowIso, queuedBudgetMs(budgets)],
  };
}

/** The queue budget, from the admin setting. */
export async function resolveWorkspaceBuildQueueWaitMs(env: Env): Promise<number> {
  const minutes = Number(
    await resolveAdminSetting(env, 'operations.workspaceBuildQueueTimeoutMinutes')
  );
  const safeMinutes =
    Number.isFinite(minutes) && minutes > 0
      ? minutes
      : DEFAULT_WORKSPACE_BUILD_QUEUE_TIMEOUT_MINUTES;
  return safeMinutes * 60_000;
}

/**
 * The one destructive decision on an expired attempt: mark it 'error' only if it is STILL
 * 'creating' and STILL past its deadline at this write. A ready callback or a build start that
 * landed after the caller read the row makes the claim lose, and the caller must not fail
 * anything. Shared by the TaskRunner's workspace_ready step and the provisioning-timeout cron, so
 * neither can act on a row it read before a concurrent transition.
 */
export async function claimWorkspaceCreatingExpiry(
  database: D1Database,
  workspaceId: string,
  nowIso: string,
  budgets: WorkspaceCreatingBudgets,
  errorMessage: string
): Promise<boolean> {
  const overdue = workspaceCreatingOverdueSql('workspaces', nowIso, budgets);
  const result = await database
    .prepare(
      `UPDATE workspaces SET status = 'error', error_message = ?, updated_at = ?
        WHERE id = ? AND status = 'creating' AND ${overdue.sql}`
    )
    .bind(errorMessage, nowIso, workspaceId, ...overdue.binds)
    .run();
  return (result.meta.changes ?? 0) === 1;
}
