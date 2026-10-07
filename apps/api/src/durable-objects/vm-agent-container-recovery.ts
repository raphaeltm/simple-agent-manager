import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import {
  parseSessionRuntimeContract,
  resolveSessionRuntimeContract,
  type SessionRuntimeContract,
} from '../services/session-runtime-contract';

export const RUNTIME_RECOVERING_MESSAGE =
  'Instant session interrupted; restoring the last safe checkpoint.';
export const RUNTIME_REQUEST_INTERRUPTED_MESSAGE =
  'Your message is saved, but delivery was interrupted and its execution outcome is unknown. It was not replayed automatically. After restore finishes, check the transcript and partial output before deciding whether to send it again.';
export const RUNTIME_RECOVERY_DEGRADED_MESSAGE =
  'The Instant session could not restore its last safe checkpoint. Your transcript and partial output are still available.';
export const RUNTIME_STOPPED_MESSAGE = 'This Instant session was stopped and cannot be resumed.';

export type RuntimeRecoveryCode =
  | 'RUNTIME_RECOVERING'
  | 'RUNTIME_REQUEST_INTERRUPTED'
  | 'RUNTIME_RECOVERY_DEGRADED'
  | 'RUNTIME_STOPPED';

export function getRuntimeRecoveryMessage(code: RuntimeRecoveryCode): string {
  if (code === 'RUNTIME_RECOVERING') return RUNTIME_RECOVERING_MESSAGE;
  if (code === 'RUNTIME_REQUEST_INTERRUPTED') return RUNTIME_REQUEST_INTERRUPTED_MESSAGE;
  if (code === 'RUNTIME_STOPPED') return RUNTIME_STOPPED_MESSAGE;
  return RUNTIME_RECOVERY_DEGRADED_MESSAGE;
}

export type RuntimeRecoveryPhase = 'pending' | 'waking' | 'restoring' | 'degraded' | 'exhausted';

export type RuntimeRecoveryTrigger = 'idle' | 'stop' | 'error' | 'request';

export type RuntimeRecoveryCause =
  | { kind: 'idle_sleep' }
  | { kind: 'container_stop'; reason: 'exit' | 'runtime_signal'; exitCode: number }
  | { kind: 'container_error'; errorName: string }
  | { kind: 'transport_interrupted'; errorName: string }
  | { kind: 'missing_session_host'; httpStatus: number };

export interface RuntimeRecoveryState {
  version: 1;
  phase: RuntimeRecoveryPhase;
  trigger: RuntimeRecoveryTrigger;
  cause: RuntimeRecoveryCause;
  attempts: number;
  promptDisposition: 'none' | 'manual_retry';
  agentSessionId: string | null;
  startedAt: number;
  updatedAt: number;
  lastFailure?: {
    kind: 'launch' | 'restore_http' | 'restore_status' | 'unexpected';
    httpStatus?: number;
  };
}

export interface RuntimeRecoveryTarget {
  nodeId: string;
  workspaceId: string;
  userId: string;
  projectId: string;
  chatSessionId: string;
  agentSessionId: string;
  runtimeIncarnationId: string | null;
}

export interface RuntimeRecoveryContext {
  userId: string;
  chatSessionId: string;
  agentSessionId: string;
  agentType: string | null;
  runtimeContract: SessionRuntimeContract | null;
  runtimeIncarnationId: string | null;
}

export function toRuntimeRecoveryTarget(
  config: { nodeId: string; workspaceId: string; projectId: string },
  context: RuntimeRecoveryContext
): RuntimeRecoveryTarget {
  return {
    nodeId: config.nodeId,
    workspaceId: config.workspaceId,
    userId: context.userId,
    projectId: config.projectId,
    chatSessionId: context.chatSessionId,
    agentSessionId: context.agentSessionId,
    runtimeIncarnationId: context.runtimeIncarnationId,
  };
}

/**
 * Workspace and node statuses the container DO may wake a runtime from, in place.
 * `sleeping` is what every sleep writer leaves behind (`persistRuntimeSleeping`,
 * `persistRuntimeSleepingAfterRevokedWake`, the scheduled sleep in
 * `services/session-sleep-execution.ts`); `error` is a container that failed while
 * running. Deletion states stay out, so a wake can never revive a runtime that
 * deletion has quarantined.
 */
export const IN_PLACE_WAKEABLE_STATUSES: readonly string[] = [
  'running',
  'creating',
  'recovery',
  'error',
  'sleeping',
];
const IN_PLACE_WAKEABLE_STATUSES_SQL = IN_PLACE_WAKEABLE_STATUSES.map(
  (status) => `'${status}'`
).join(', ');

export async function loadRuntimeRecoveryContext(
  env: Env,
  input: { workspaceId: string; preferredAgentSessionId?: string | null }
): Promise<RuntimeRecoveryContext | null> {
  const db = drizzle(env.DATABASE, { schema });
  const workspace = await db
    .select({
      projectId: schema.workspaces.projectId,
      userId: schema.workspaces.userId,
      chatSessionId: schema.workspaces.chatSessionId,
      runtimeIncarnationId: schema.nodes.runtimeIncarnationId,
    })
    .from(schema.workspaces)
    .innerJoin(schema.nodes, eq(schema.nodes.id, schema.workspaces.nodeId))
    .where(
      and(
        eq(schema.workspaces.id, input.workspaceId),
        inArray(schema.workspaces.status, [...IN_PLACE_WAKEABLE_STATUSES]),
        isNull(schema.workspaces.runtimeDeletionConfirmedAt),
        eq(schema.nodes.runtime, 'cf-container'),
        inArray(schema.nodes.status, [...IN_PLACE_WAKEABLE_STATUSES])
      )
    )
    .get();
  if (!workspace?.chatSessionId) return null;

  const agentSession = await db
    .select({
      id: schema.agentSessions.id,
      agentType: schema.agentSessions.agentType,
      runtimeContractJson: schema.agentSessions.runtimeContractJson,
    })
    .from(schema.agentSessions)
    .where(
      input.preferredAgentSessionId
        ? and(
            eq(schema.agentSessions.workspaceId, input.workspaceId),
            eq(schema.agentSessions.id, input.preferredAgentSessionId)
          )
        : eq(schema.agentSessions.workspaceId, input.workspaceId)
    )
    .orderBy(desc(schema.agentSessions.updatedAt))
    .get();
  if (!agentSession) return null;

  let runtimeContract = parseSessionRuntimeContract(agentSession.runtimeContractJson);
  if (!runtimeContract) {
    if (!workspace.projectId || !agentSession.agentType)
      throw new Error('Legacy runtime contract identity unavailable');
    const task = await db
      .select()
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.chatSessionId, workspace.chatSessionId),
          eq(schema.tasks.projectId, workspace.projectId),
          eq(schema.tasks.userId, workspace.userId)
        )
      )
      .orderBy(desc(schema.tasks.updatedAt))
      .get();
    runtimeContract = await resolveSessionRuntimeContract(db, env, {
      projectId: workspace.projectId,
      userId: workspace.userId,
      agentType: agentSession.agentType,
      promptKind: task ? 'task' : 'conversation',
      overrides: { permissionMode: 'default' },
      taskContext: task
        ? { taskId: task.id, taskMode: task.taskMode === 'task' ? 'task' : 'conversation' }
        : null,
    });
  }
  if (runtimeContract.taskContext && runtimeContract.taskContext.projectId !== workspace.projectId)
    throw new Error('Session runtime contract project mismatch');
  return {
    userId: workspace.userId,
    chatSessionId: workspace.chatSessionId,
    agentSessionId: agentSession.id,
    agentType: agentSession.agentType,
    runtimeContract,
    runtimeIncarnationId: workspace.runtimeIncarnationId,
  };
}

export async function persistRuntimeRecovering(
  env: Env,
  target: RuntimeRecoveryTarget
): Promise<RuntimeRecoveryTarget | null> {
  const now = new Date().toISOString();
  const runtimeIncarnationId = crypto.randomUUID();
  const [nodeResult, workspaceResult] = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE nodes
       SET status = 'recovery',
           health_status = 'unhealthy',
           error_message = ?,
           runtime_termination_confirmed_at = NULL,
           runtime_incarnation_id = ?,
           updated_at = ?
       WHERE id = ?
         AND user_id = ?
         AND runtime = 'cf-container'
         AND runtime_incarnation_id IS ?
         AND status IN (${IN_PLACE_WAKEABLE_STATUSES_SQL})
         AND EXISTS (
           SELECT 1 FROM workspaces w
           WHERE w.id = ?
             AND w.node_id = nodes.id
             AND w.user_id = ?
             AND w.project_id IS ?
             AND w.chat_session_id IS ?
             AND w.status IN (${IN_PLACE_WAKEABLE_STATUSES_SQL})
             AND w.runtime_deletion_confirmed_at IS NULL
         )`
    ).bind(
      RUNTIME_RECOVERING_MESSAGE,
      runtimeIncarnationId,
      now,
      target.nodeId,
      target.userId,
      target.runtimeIncarnationId,
      target.workspaceId,
      target.userId,
      target.projectId,
      target.chatSessionId
    ),
    env.DATABASE.prepare(
      `UPDATE workspaces
       SET status = 'recovery', error_message = ?, updated_at = ?
       WHERE id = ?
         AND node_id = ?
         AND user_id = ?
         AND project_id IS ?
         AND chat_session_id IS ?
         AND status IN (${IN_PLACE_WAKEABLE_STATUSES_SQL})
         AND runtime_deletion_confirmed_at IS NULL
         AND EXISTS (
           SELECT 1 FROM nodes
           WHERE id = ?
             AND user_id = ?
             AND runtime = 'cf-container'
             AND runtime_incarnation_id IS ?
             AND status = 'recovery'
         )`
    ).bind(
      RUNTIME_RECOVERING_MESSAGE,
      now,
      target.workspaceId,
      target.nodeId,
      target.userId,
      target.projectId,
      target.chatSessionId,
      target.nodeId,
      target.userId,
      runtimeIncarnationId
    ),
    env.DATABASE.prepare(
      `UPDATE agent_sessions
       SET status = 'recovery', stopped_at = NULL, error_message = ?, updated_at = ?
       WHERE id = ?
         AND workspace_id = ?
         AND user_id = ?
         AND EXISTS (
           SELECT 1
             FROM workspaces w
             JOIN nodes n ON n.id = w.node_id
            WHERE w.id = ?
              AND w.node_id = ?
              AND w.user_id = ?
              AND w.project_id IS ?
              AND w.chat_session_id IS ?
              AND w.status = 'recovery'
              AND w.runtime_deletion_confirmed_at IS NULL
              AND n.user_id = ?
              AND n.runtime = 'cf-container'
              AND n.runtime_incarnation_id IS ?
              AND n.status = 'recovery'
         )`
    ).bind(
      RUNTIME_RECOVERING_MESSAGE,
      now,
      target.agentSessionId,
      target.workspaceId,
      target.userId,
      target.workspaceId,
      target.nodeId,
      target.userId,
      target.projectId,
      target.chatSessionId,
      target.userId,
      runtimeIncarnationId
    ),
  ]);
  if ((nodeResult?.meta.changes ?? 0) !== 1 || (workspaceResult?.meta.changes ?? 0) !== 1) {
    return null;
  }
  return { ...target, runtimeIncarnationId };
}

export async function persistRuntimeRecovered(
  env: Env,
  target: RuntimeRecoveryTarget,
  promptDisposition: RuntimeRecoveryState['promptDisposition']
): Promise<boolean> {
  const now = new Date().toISOString();
  const agentMessage =
    promptDisposition === 'manual_retry' ? RUNTIME_REQUEST_INTERRUPTED_MESSAGE : null;
  const [nodeResult, workspaceResult] = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE nodes
       SET status = 'running',
           health_status = 'healthy',
           error_message = NULL,
           runtime_termination_confirmed_at = NULL,
           updated_at = ?
       WHERE id = ?
         AND user_id = ?
         AND runtime = 'cf-container'
         AND runtime_incarnation_id IS ?
         AND status IN ('running', 'recovery')
         AND EXISTS (
           SELECT 1 FROM workspaces w
            WHERE w.id = ?
              AND w.node_id = nodes.id
              AND w.user_id = ?
              AND w.project_id IS ?
              AND w.chat_session_id IS ?
              AND w.status IN ('running', 'recovery')
              AND w.runtime_deletion_confirmed_at IS NULL
         )`
    ).bind(
      now,
      target.nodeId,
      target.userId,
      target.runtimeIncarnationId,
      target.workspaceId,
      target.userId,
      target.projectId,
      target.chatSessionId
    ),
    env.DATABASE.prepare(
      `UPDATE workspaces
       SET status = 'running', error_message = NULL, updated_at = ?
       WHERE id = ?
         AND node_id = ?
         AND user_id = ?
         AND project_id IS ?
         AND chat_session_id IS ?
         AND status IN ('running', 'recovery')
         AND runtime_deletion_confirmed_at IS NULL
         AND EXISTS (
           SELECT 1 FROM nodes
           WHERE id = ?
             AND user_id = ?
             AND runtime = 'cf-container'
             AND runtime_incarnation_id IS ?
             AND status = 'running'
         )`
    ).bind(
      now,
      target.workspaceId,
      target.nodeId,
      target.userId,
      target.projectId,
      target.chatSessionId,
      target.nodeId,
      target.userId,
      target.runtimeIncarnationId
    ),
    env.DATABASE.prepare(
      `UPDATE agent_sessions
       SET status = 'running', stopped_at = NULL, error_message = ?, updated_at = ?
       WHERE id = ?
         AND workspace_id = ?
         AND user_id = ?
         AND EXISTS (
           SELECT 1
             FROM workspaces w
             JOIN nodes n ON n.id = w.node_id
            WHERE w.id = ?
              AND w.node_id = ?
              AND w.user_id = ?
              AND w.project_id IS ?
              AND w.chat_session_id IS ?
              AND w.status = 'running'
              AND w.runtime_deletion_confirmed_at IS NULL
              AND n.user_id = ?
              AND n.runtime = 'cf-container'
              AND n.runtime_incarnation_id IS ?
              AND n.status = 'running'
         )`
    ).bind(
      agentMessage,
      now,
      target.agentSessionId,
      target.workspaceId,
      target.userId,
      target.workspaceId,
      target.nodeId,
      target.userId,
      target.projectId,
      target.chatSessionId,
      target.userId,
      target.runtimeIncarnationId
    ),
  ]);
  return (nodeResult?.meta.changes ?? 0) === 1 && (workspaceResult?.meta.changes ?? 0) === 1;
}
