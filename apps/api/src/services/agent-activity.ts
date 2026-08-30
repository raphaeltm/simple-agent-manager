import {
  type AgentActivityState,
  isTaskExecutionStep,
  type TaskExecutionStep,
  type TaskStatus,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import {
  DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS,
  isRestorableSnapshot,
} from './session-snapshot-artifacts';

export const AGENT_ACTIVITY_ACTIVE_TASK_STATUSES = [
  'queued',
  'delegated',
  'in_progress',
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
  priority: number;
  createdAt: string;
  startedAt: string | null;
  agentActivityState: AgentActivityState;
}

interface AgentActivitySqlRow {
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
}

export interface ListAgentActivityTasksOptions {
  userId?: string;
  projectId?: string;
  activeOnly?: boolean;
  excludeTaskId?: string | null;
  limit?: number;
  nowMs?: number;
}

type AgentActivityEnv = Pick<Env, 'DATABASE' | 'SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS'>;

function getMaxRecoveryAttempts(env: AgentActivityEnv): number {
  return parsePositiveInt(
    env.SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS,
    DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS
  );
}

type SleepingActivityFields = Pick<
  AgentActivitySqlRow,
  | 'snapshotSleepStatus'
  | 'snapshotSleepingAt'
  | 'snapshotStatus'
  | 'snapshotDegradation'
  | 'snapshotExpiresAt'
  | 'snapshotRecoveryAttempts'
>;

function isRestorableSleepingActivity(
  row: SleepingActivityFields,
  maxAttempts: number,
  nowMs: number
): boolean {
  if (row.snapshotSleepStatus !== 'sleeping') return false;
  if (!row.snapshotSleepingAt) return false;
  if (!isRestorableSnapshot(row.snapshotStatus, row.snapshotDegradation)) return false;
  if ((row.snapshotRecoveryAttempts ?? 0) >= maxAttempts) return false;
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
  >,
  maxAttempts: number,
  nowMs: number
): AgentActivityState {
  if (row.supersededByTaskId) return 'superseded';
  if (isRestorableSleepingActivity(row, maxAttempts, nowMs)) {
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

  const limit = normalizedLimit(options.limit);
  const sql = `
    SELECT
      t.id AS id,
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
      t.priority AS priority,
      t.created_at AS createdAt,
      t.started_at AS startedAt,
      w.status AS workspaceStatus,
      snapshot.sleep_status AS snapshotSleepStatus,
      snapshot.sleeping_at AS snapshotSleepingAt,
      snapshot.status AS snapshotStatus,
      snapshot.degradation AS snapshotDegradation,
      snapshot.expires_at AS snapshotExpiresAt,
      snapshot.recovery_attempts AS snapshotRecoveryAttempts
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
  const maxAttempts = getMaxRecoveryAttempts(env);
  const nowMs = options.nowMs ?? Date.now();

  return rows.map((row) => ({
    id: row.id,
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
    priority: row.priority ?? 0,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    agentActivityState: deriveAgentActivityState(row, maxAttempts, nowMs),
  }));
}
