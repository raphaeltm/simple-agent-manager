import {
  type AgentActivityState,
  isTaskExecutionStep,
  type TaskExecutionStep,
  type TaskStatus,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { escapeSearchQueryForLike } from '../lib/search-query-limits';
import { isRestorableSnapshot } from './session-snapshot-artifacts';
import {
  sessionRecoveryAttemptDecayMs,
  sessionRecoveryBudgetAvailable,
  sessionRecoveryMaxAttempts,
} from './session-snapshot-recovery-budget';

export const AGENT_ACTIVITY_ACTIVE_TASK_STATUSES = [
  'queued',
  'delegated',
  'in_progress',
  'sleeping',
] as const satisfies readonly TaskStatus[];

const WORKING_EXECUTION_STEPS = new Set<TaskExecutionStep>([
  'node_selection',
  'waiting_for_node_capacity',
  'node_provisioning',
  'node_agent_ready',
  'workspace_creation',
  'workspace_dispatch',
  'workspace_ready',
  'attachment_transfer',
  'agent_session',
  'running',
] as const);

export interface AgentActivityTask {
  triggeredBy?: string | null;
  connectorClientName?: string | null;
  id: string;
  title: string;
  status: string;
  executionStep: string | null;
  projectId: string;
  projectName: string;
  userId: string;
  workspaceId: string | null;
  chatSessionId: string | null;
  supersededByTaskId: string | null;
  outputBranch: string | null;
  outputPrUrl: string | null;
  /** Branch the task's current workspace checked out; null before one exists. */
  workspaceBranch: string | null;
  priority: number;
  createdAt: string;
  startedAt: string | null;
  agentActivityState: AgentActivityState;
}

interface AgentActivitySqlRow {
  triggeredBy: string | null;
  connectorClientName: string | null;
  id: string;
  title: string;
  status: string;
  executionStep: string | null;
  projectId: string;
  projectName: string;
  userId: string;
  workspaceId: string | null;
  chatSessionId: string | null;
  supersededByTaskId: string | null;
  outputBranch: string | null;
  outputPrUrl: string | null;
  workspaceBranch: string | null;
  priority: number | null;
  createdAt: string;
  startedAt: string | null;
  workspaceStatus: string | null;
  snapshotSleepStatus: string | null;
  snapshotSleepingAt: string | null;
  snapshotStatus: string | null;
  snapshotDegradation: string | null;
  snapshotExpiresAt: string | null;
  snapshotRecoveryAttempts: number | null;
  snapshotRecoveryFailedAt: string | null;
}

/** Identifies one pull request; a task matching any link counts as its owner. */
export interface PullRequestOwnerFilter {
  /** The PR's head branch, matched against output and workspace branches. */
  headBranch?: string;
  /** The PR's URL, matched against the output PR URL and cited in the description. */
  url?: string;
}

export interface ListAgentActivityTasksOptions {
  userId?: string;
  projectId?: string;
  activeOnly?: boolean;
  excludeTaskId?: string | null;
  /** Restrict the list to tasks that own this pull request. */
  ownsPullRequest?: PullRequestOwnerFilter;
  limit?: number;
  nowMs?: number;
}

type AgentActivityEnv = Pick<
  Env,
  | 'DATABASE'
  | 'SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS'
  | 'SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS'
>;

type SleepingActivityFields = Pick<
  AgentActivitySqlRow,
  | 'snapshotSleepStatus'
  | 'snapshotSleepingAt'
  | 'snapshotStatus'
  | 'snapshotDegradation'
  | 'snapshotExpiresAt'
  | 'snapshotRecoveryAttempts'
  | 'snapshotRecoveryFailedAt'
>;

function isRestorableSleepingActivity(
  row: SleepingActivityFields,
  maxAttempts: number,
  nowMs: number,
  decayMs: number
): boolean {
  if (row.snapshotSleepStatus !== 'sleeping') return false;
  if (!row.snapshotSleepingAt) return false;
  if (!isRestorableSnapshot(row.snapshotStatus, row.snapshotDegradation)) return false;
  // Same burst-budget rule the resumer applies, decay included, so a session the
  // user can still wake is never displayed as no longer sleeping.
  const failedAtMs = row.snapshotRecoveryFailedAt
    ? Date.parse(row.snapshotRecoveryFailedAt)
    : Number.NaN;
  if (
    !sessionRecoveryBudgetAvailable({
      recoveryAttempts: row.snapshotRecoveryAttempts ?? 0,
      recoveryFailedAtMs: Number.isFinite(failedAtMs) ? failedAtMs : null,
      maxAttempts,
      decayMs,
      nowMs,
    })
  ) {
    return false;
  }
  if (!row.snapshotExpiresAt) return false;
  const expiresAtMs = Date.parse(row.snapshotExpiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

export function deriveAgentActivityState(
  row: Pick<
    AgentActivitySqlRow,
    | 'status'
    | 'executionStep'
    | 'workspaceStatus'
    | 'supersededByTaskId'
    | 'snapshotSleepStatus'
    | 'snapshotSleepingAt'
    | 'snapshotStatus'
    | 'snapshotDegradation'
    | 'snapshotExpiresAt'
    | 'snapshotRecoveryAttempts'
    | 'snapshotRecoveryFailedAt'
  >,
  maxAttempts: number,
  nowMs: number,
  decayMs: number
): AgentActivityState {
  if (row.supersededByTaskId) return 'superseded';
  if (isRestorableSleepingActivity(row, maxAttempts, nowMs, decayMs)) {
    return 'sleeping';
  }
  if (row.status === 'queued' || row.status === 'delegated') return 'working';
  if (row.status === 'in_progress') {
    if (row.workspaceStatus === 'running') return 'working';
    if (isTaskExecutionStep(row.executionStep) && WORKING_EXECUTION_STEPS.has(row.executionStep)) {
      return 'working';
    }
  }
  return 'awake-idle';
}

function appendScopeCondition(
  conditions: string[],
  binds: unknown[],
  column: 'user_id' | 'project_id',
  value: string | undefined
): void {
  if (!value) return;
  conditions.push(`t.${column} = ?`);
  binds.push(value);
}

function appendActiveCondition(conditions: string[], binds: unknown[]): void {
  conditions.push(`t.status IN (${AGENT_ACTIVITY_ACTIVE_TASK_STATUSES.map(() => '?').join(', ')})`);
  binds.push(...AGENT_ACTIVITY_ACTIVE_TASK_STATUSES);
  conditions.push('t.superseded_by_task_id IS NULL');
}

/**
 * A task owns a pull request when it will push to the PR's head branch, has
 * reported the PR as its output, or was dispatched to work on it. No single
 * column covers every owner:
 * - `t.output_branch`: the task that opened the PR. The VM agent also rewrites it
 *   to the pushed branch whenever a task-mode turn ends.
 * - `w.branch`: a completion task dispatched with `branch=<head>`. Until its first
 *   turn ends, its output branch is still its own generated name. The column keeps
 *   the branch checked out at workspace creation and is never resynced.
 * - `t.output_pr_url`: written by `complete_task`, including conversation-mode
 *   tasks that stay active awaiting follow-up.
 * - `t.description` citing the URL: a task dispatched for the PR whose workspace
 *   does not exist yet (for example while waiting for node capacity). A URL that
 *   is a prefix of another PR's URL also matches; a false owner only defers.
 */
function appendPullRequestOwnerCondition(
  conditions: string[],
  binds: unknown[],
  filter: PullRequestOwnerFilter
): void {
  const links: string[] = [];
  if (filter.headBranch) {
    links.push('t.output_branch = ?', 'w.branch = ?');
    binds.push(filter.headBranch, filter.headBranch);
  }
  if (filter.url) {
    links.push('t.output_pr_url = ?', "t.description LIKE ? ESCAPE '\\'");
    binds.push(filter.url, `%${escapeSearchQueryForLike(filter.url)}%`);
  }
  // An empty filter would return every task as an owner; refuse it outright.
  if (links.length === 0) {
    throw new Error('ownsPullRequest requires a headBranch or url');
  }
  conditions.push(`(${links.join(' OR ')})`);
}

function normalizedLimit(limit: number | undefined): number | null {
  if (limit === undefined) return null;
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return Math.floor(limit);
}

export async function listAgentActivityTasks(
  env: AgentActivityEnv,
  options: ListAgentActivityTasksOptions
): Promise<AgentActivityTask[]> {
  if (!options.userId && !options.projectId) {
    throw new Error('listAgentActivityTasks requires userId or projectId scope');
  }

  const activeOnly = options.activeOnly ?? true;
  const conditions: string[] = [];
  const binds: unknown[] = [];
  appendScopeCondition(conditions, binds, 'user_id', options.userId);
  appendScopeCondition(conditions, binds, 'project_id', options.projectId);
  if (options.excludeTaskId) {
    conditions.push('t.id != ?');
    binds.push(options.excludeTaskId);
  }
  if (activeOnly) appendActiveCondition(conditions, binds);
  if (options.ownsPullRequest) {
    appendPullRequestOwnerCondition(conditions, binds, options.ownsPullRequest);
  }

  const limit = normalizedLimit(options.limit);
  const sql = `
    SELECT
      t.id AS id,
      t.triggered_by AS triggeredBy,
      t.connector_client_name AS connectorClientName,
      t.title AS title,
      t.status AS status,
      t.execution_step AS executionStep,
      t.project_id AS projectId,
      p.name AS projectName,
      t.user_id AS userId,
      t.workspace_id AS workspaceId,
      t.chat_session_id AS chatSessionId,
      t.superseded_by_task_id AS supersededByTaskId,
      t.output_branch AS outputBranch,
      t.output_pr_url AS outputPrUrl,
      w.branch AS workspaceBranch,
      t.priority AS priority,
      t.created_at AS createdAt,
      t.started_at AS startedAt,
      w.status AS workspaceStatus,
      snapshot.sleep_status AS snapshotSleepStatus,
      snapshot.sleeping_at AS snapshotSleepingAt,
      snapshot.status AS snapshotStatus,
      snapshot.degradation AS snapshotDegradation,
      snapshot.expires_at AS snapshotExpiresAt,
      snapshot.recovery_attempts AS snapshotRecoveryAttempts,
      snapshot.recovery_failed_at AS snapshotRecoveryFailedAt
    FROM tasks t
    INNER JOIN projects p ON p.id = t.project_id
    LEFT JOIN workspaces w
      ON w.id = t.workspace_id
     AND w.project_id = t.project_id
    LEFT JOIN session_snapshots snapshot
      ON snapshot.project_id = t.project_id
     AND snapshot.chat_session_id = t.chat_session_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY COALESCE(t.started_at, t.created_at) DESC, t.id ASC
    ${limit === null ? '' : 'LIMIT ?'}
  `;
  if (limit !== null) binds.push(limit);

  const result = await env.DATABASE.prepare(sql)
    .bind(...binds)
    .all<AgentActivitySqlRow>();
  const rows = result.results ?? [];
  const maxAttempts = sessionRecoveryMaxAttempts(env);
  const decayMs = sessionRecoveryAttemptDecayMs(env);
  const nowMs = options.nowMs ?? Date.now();

  return rows.map((row) => ({
    id: row.id,
    triggeredBy: row.triggeredBy,
    connectorClientName: row.connectorClientName,
    title: row.title,
    status: row.status,
    executionStep: row.executionStep,
    projectId: row.projectId,
    projectName: row.projectName,
    userId: row.userId,
    workspaceId: row.workspaceId,
    chatSessionId: row.chatSessionId,
    supersededByTaskId: row.supersededByTaskId,
    outputBranch: row.outputBranch,
    outputPrUrl: row.outputPrUrl,
    workspaceBranch: row.workspaceBranch,
    priority: row.priority ?? 0,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    agentActivityState: deriveAgentActivityState(row, maxAttempts, nowMs, decayMs),
  }));
}
