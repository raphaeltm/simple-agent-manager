/**
 * Provisioning Timeout Service
 *
 * Handles detection and marking of workspaces stuck in 'creating' status.
 * Called by cron trigger every 5 minutes.
 *
 * TDF-7: Enhanced with OBSERVABILITY_DATABASE recording and structured
 * logging for admin visibility of provisioning timeout recoveries.
 */

import type { Env } from '../env';
import { log } from '../lib/logger';
import {
  DEFAULT_WORKSPACE_BUILD_QUEUE_TIMEOUT_MINUTES,
} from '../scheduler-core';
import { persistError } from './observability';
import {
  claimWorkspaceCreatingExpiry,
  resolveWorkspaceBuildQueueWaitMs,
  type WorkspaceCreatingBudgets,
  workspaceCreatingOverdueSql,
} from './workspace-creating-deadline';

/** Default provisioning timeout in milliseconds (30 minutes): this cron's build budget, measured
 * from the durable build start (`workspace-creating-deadline.ts`).
 * Must be >= TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS (the TaskRunner DO's build budget) to avoid
 * the cron marking workspaces as timed out while the DO is still legitimately waiting for the
 * workspace-ready callback. */
const DEFAULT_PROVISIONING_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Get provisioning timeout from env or use default (per constitution principle XI).
 */
export function getProvisioningTimeoutMs(env?: { PROVISIONING_TIMEOUT_MS?: string }): number {
  if (env?.PROVISIONING_TIMEOUT_MS) {
    const timeout = parseInt(env.PROVISIONING_TIMEOUT_MS, 10);
    if (!isNaN(timeout) && timeout > 0) {
      return timeout;
    }
  }
  return DEFAULT_PROVISIONING_TIMEOUT_MS;
}

/**
 * Check for and handle workspaces stuck in 'creating' status.
 * Marks them as 'error' with a descriptive message.
 *
 * Uses the shared per-attempt deadline (`workspace-creating-deadline.ts`) with this cron's build
 * budget, `PROVISIONING_TIMEOUT_MS`, which must stay >= the TaskRunner's
 * `TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS` so the DO, not this backstop, normally times a task
 * out. The UPDATE repeats the status and deadline predicates, so a workspace that became ready or
 * recorded its build start since the read is left alone.
 *
 * @param database - D1 database binding
 * @param env - Environment for reading configurable timeout
 * @param observabilityDb - Optional OBSERVABILITY_DATABASE for recording timeouts (TDF-7)
 * @returns Number of workspaces that timed out
 */
export async function checkProvisioningTimeouts(
  database: D1Database,
  env?: Env,
  observabilityDb?: D1Database
): Promise<number> {
  const now = new Date();
  const nowIso = now.toISOString();
  const budgets = await resolveProvisioningTimeoutBudgets(env);
  const overdue = workspaceCreatingOverdueSql('w', nowIso, budgets);

  // Find workspaces stuck in 'creating' past their deadline.
  // Include node_id and user_id for diagnostic context (TDF-7)
  const stuck = await database
    .prepare(
      `SELECT w.id, w.node_id AS nodeId, w.user_id AS userId, w.created_at AS createdAt,
              w.creating_started_at AS creatingStartedAt, w.build_started_at AS buildStartedAt
         FROM workspaces w
        WHERE w.status = 'creating' AND ${overdue.sql}`
    )
    .bind(...overdue.binds)
    .all<StuckWorkspaceRow>();
  const stuckWorkspaces = stuck.results ?? [];

  if (stuckWorkspaces.length === 0) {
    return 0;
  }

  let timedOut = 0;
  for (const workspace of stuckWorkspaces) {
    const phase = workspace.buildStartedAt ? 'building' : 'queued';
    const budgetMs =
      phase === 'building' ? budgets.buildMs : Math.max(budgets.queueWaitMs, budgets.buildMs);
    const timeoutMinutes = Math.round(budgetMs / 60000);
    const timeoutMessage =
      phase === 'building'
        ? `Provisioning timed out ${timeoutMinutes} minutes after the workspace build started`
        : `Provisioning timed out: the workspace build did not start within ${timeoutMinutes} minutes`;
    if (
      !(await claimWorkspaceCreatingExpiry(database, workspace.id, nowIso, budgets, timeoutMessage))
    ) {
      log.info('provisioning_timeout.workspace_changed_before_timeout', {
        workspaceId: workspace.id,
        nodeId: workspace.nodeId,
        action: 'skipped',
      });
      continue;
    }
    timedOut++;

    log.warn('provisioning_timeout.workspace_timed_out', {
      workspaceId: workspace.id,
      nodeId: workspace.nodeId,
      userId: workspace.userId,
      createdAt: workspace.createdAt,
      creatingStartedAt: workspace.creatingStartedAt,
      buildStartedAt: workspace.buildStartedAt,
      phase,
      timeoutMinutes,
    });

    // Record in OBSERVABILITY_DATABASE (TDF-7)
    if (observabilityDb) {
      await persistError(
        observabilityDb,
        {
          source: 'api',
          level: 'warn',
          message: timeoutMessage,
          context: {
            recoveryType: 'provisioning_timeout',
            workspaceId: workspace.id,
            nodeId: workspace.nodeId,
            createdAt: workspace.createdAt,
            creatingStartedAt: workspace.creatingStartedAt,
            buildStartedAt: workspace.buildStartedAt,
            phase,
            timeoutMs: budgetMs,
          },
          userId: workspace.userId,
          nodeId: workspace.nodeId,
          workspaceId: workspace.id,
        },
        env
      );
    }
  }

  log.info('provisioning_timeout.summary', {
    timedOutCount: timedOut,
    candidateCount: stuckWorkspaces.length,
    buildTimeoutMinutes: Math.round(budgets.buildMs / 60000),
    queueTimeoutMinutes: Math.round(budgets.queueWaitMs / 60000),
  });

  return timedOut;
}

interface StuckWorkspaceRow {
  id: string;
  nodeId: string | null;
  userId: string;
  createdAt: string;
  creatingStartedAt: string | null;
  buildStartedAt: string | null;
}

/** This cron's budgets: its own build budget, the shared queue budget. */
export async function resolveProvisioningTimeoutBudgets(
  env?: Env
): Promise<WorkspaceCreatingBudgets> {
  return {
    buildMs: getProvisioningTimeoutMs(env),
    queueWaitMs: env
      ? await resolveWorkspaceBuildQueueWaitMs(env)
      : DEFAULT_WORKSPACE_BUILD_QUEUE_TIMEOUT_MINUTES * 60_000,
  };
}

/**
 * Whether a task's workspace is still legitimately starting: in 'creating' and inside the shared
 * deadline at this cron's (backstop) budgets. The stuck-task sweep defers to this instead of
 * failing a delegated task on its own shorter, dispatch-anchored clock while the workspace waits
 * for its node's build slot.
 *
 *   starting      in 'creating' and inside the deadline: not stuck
 *   not_starting  conclusively not: past the deadline, not 'creating', or no such row
 *   unknown       the read failed: an unknown deadline is not evidence of an overdue one, so the
 *                 sweep withholds its terminal verdict for this pass and asks again next pass
 */
export type CreatingDeadlineProbe = 'starting' | 'not_starting' | 'unknown';

export async function probeWorkspaceCreatingDeadline(
  database: D1Database,
  env: Env,
  workspaceId: string,
  now: Date
): Promise<CreatingDeadlineProbe> {
  try {
    const budgets = await resolveProvisioningTimeoutBudgets(env);
    const overdue = workspaceCreatingOverdueSql('w', now.toISOString(), budgets);
    const row = await database
      .prepare(
        `SELECT 1 AS starting FROM workspaces w
          WHERE w.id = ? AND w.status = 'creating' AND NOT ${overdue.sql}`
      )
      .bind(workspaceId, ...overdue.binds)
      .first<{ starting: number }>();
    return row?.starting === 1 ? 'starting' : 'not_starting';
  } catch (error) {
    log.warn('provisioning_timeout.creating_deadline_probe_failed', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
      action: 'verdict_withheld',
    });
    return 'unknown';
  }
}
