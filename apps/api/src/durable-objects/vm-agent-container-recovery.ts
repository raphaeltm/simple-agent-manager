import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import * as projectDataService from '../services/project-data';

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

const ACTIVE_TASK_STATUSES = ['in_progress', 'delegated', 'awaiting_followup'] as const;

export async function loadRuntimeRecoveryContext(
  env: Env,
  input: { workspaceId: string; preferredAgentSessionId?: string | null }
): Promise<RuntimeRecoveryContext | null> {
  const db = drizzle(env.DATABASE, { schema });
  const workspace = await db
    .select({
      userId: schema.workspaces.userId,
      chatSessionId: schema.workspaces.chatSessionId,
      runtimeIncarnationId: schema.nodes.runtimeIncarnationId,
    })
    .from(schema.workspaces)
    .innerJoin(schema.nodes, eq(schema.nodes.id, schema.workspaces.nodeId))
    .where(
      and(
        eq(schema.workspaces.id, input.workspaceId),
        inArray(schema.workspaces.status, ['running', 'creating', 'recovery', 'error']),
        isNull(schema.workspaces.runtimeDeletionConfirmedAt),
        eq(schema.nodes.runtime, 'cf-container'),
        inArray(schema.nodes.status, ['running', 'creating', 'recovery', 'error'])
      )
    )
    .get();
  if (!workspace?.chatSessionId) return null;

  const agentSession = await db
    .select({ id: schema.agentSessions.id, agentType: schema.agentSessions.agentType })
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

  return {
    userId: workspace.userId,
    chatSessionId: workspace.chatSessionId,
    agentSessionId: agentSession.id,
    agentType: agentSession.agentType,
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
         AND status IN ('running', 'creating', 'recovery', 'error')
         AND EXISTS (
           SELECT 1 FROM workspaces w
           WHERE w.id = ?
             AND w.node_id = nodes.id
             AND w.user_id = ?
             AND w.project_id IS ?
             AND w.chat_session_id IS ?
             AND w.status IN ('running', 'creating', 'recovery', 'error')
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
         AND status IN ('running', 'creating', 'recovery', 'error')
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

export async function persistRuntimeRecoveryFailed(
  env: Env,
  target: RuntimeRecoveryTarget
): Promise<boolean> {
  const db = drizzle(env.DATABASE, { schema });
  const now = new Date().toISOString();
  const task = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.workspaceId, target.workspaceId),
        inArray(schema.tasks.status, [...ACTIVE_TASK_STATUSES])
      )
    )
    .orderBy(desc(schema.tasks.updatedAt))
    .get();

  const statements: D1PreparedStatement[] = [
    env.DATABASE.prepare(
      `UPDATE nodes
       SET status = 'error', health_status = 'unhealthy', error_message = ?, updated_at = ?
       WHERE id = ?
         AND user_id = ?
         AND runtime = 'cf-container'
         AND runtime_incarnation_id IS ?
         AND status = 'recovery'
         AND EXISTS (
           SELECT 1 FROM workspaces w
            WHERE w.id = ?
              AND w.node_id = nodes.id
              AND w.user_id = ?
              AND w.project_id IS ?
              AND w.chat_session_id IS ?
              AND w.status = 'recovery'
              AND w.runtime_deletion_confirmed_at IS NULL
         )`
    ).bind(
      RUNTIME_RECOVERY_DEGRADED_MESSAGE,
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
          SET status = 'error', error_message = ?, updated_at = ?
        WHERE id = ?
          AND node_id = ?
          AND user_id = ?
          AND project_id IS ?
          AND chat_session_id IS ?
          AND status = 'recovery'
          AND runtime_deletion_confirmed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM nodes
             WHERE id = ?
               AND user_id = ?
               AND runtime = 'cf-container'
               AND runtime_incarnation_id IS ?
               AND status = 'error'
          )`
    ).bind(
      RUNTIME_RECOVERY_DEGRADED_MESSAGE,
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
       SET status = 'error', stopped_at = ?, error_message = ?, updated_at = ?
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
              AND w.status = 'error'
              AND w.runtime_deletion_confirmed_at IS NULL
              AND n.user_id = ?
              AND n.runtime = 'cf-container'
              AND n.runtime_incarnation_id IS ?
              AND n.status = 'error'
         )`
    ).bind(
      now,
      RUNTIME_RECOVERY_DEGRADED_MESSAGE,
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
  ];

  if (task) {
    statements.push(
      env.DATABASE.prepare(
        `INSERT INTO task_status_events
           (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
         SELECT ?, id, status, 'failed', 'system', ?, ?, ?
         FROM tasks
         WHERE id = ?
           AND status IN ('in_progress', 'delegated', 'awaiting_followup')
           AND EXISTS (
             SELECT 1 FROM workspaces w
              WHERE w.id = ?
                AND w.node_id = ?
                AND w.user_id = ?
                AND w.project_id IS ?
                AND w.chat_session_id IS ?
                AND w.status = 'error'
           )`
      ).bind(
        ulid(),
        target.nodeId,
        'Instant runtime recovery exhausted',
        now,
        task.id,
        target.workspaceId,
        target.nodeId,
        target.userId,
        target.projectId,
        target.chatSessionId
      ),
      env.DATABASE.prepare(
        `UPDATE tasks
         SET status = 'failed', execution_step = NULL, error_message = ?, updated_at = ?
         WHERE id = ?
           AND status IN ('in_progress', 'delegated', 'awaiting_followup')
           AND EXISTS (
             SELECT 1 FROM workspaces w
              WHERE w.id = ?
                AND w.node_id = ?
                AND w.user_id = ?
                AND w.project_id IS ?
                AND w.chat_session_id IS ?
                AND w.status = 'error'
           )`
      ).bind(
        RUNTIME_RECOVERY_DEGRADED_MESSAGE,
        now,
        task.id,
        target.workspaceId,
        target.nodeId,
        target.userId,
        target.projectId,
        target.chatSessionId
      )
    );
  }

  const [nodeResult, workspaceResult] = await env.DATABASE.batch(statements);
  if ((nodeResult?.meta.changes ?? 0) !== 1 || (workspaceResult?.meta.changes ?? 0) !== 1) {
    return false;
  }

  await projectDataService
    .transitionAcpSession(env, target.projectId, target.agentSessionId, 'failed', {
      actorType: 'system',
      actorId: target.nodeId,
      reason: 'Instant runtime recovery exhausted',
      errorMessage: RUNTIME_RECOVERY_DEGRADED_MESSAGE,
      workspaceId: target.workspaceId,
      nodeId: target.nodeId,
    })
    .catch((error) => {
      log.warn('vm_agent_container_recovery.acp_reconcile_failed', {
        nodeId: target.nodeId,
        workspaceId: target.workspaceId,
        error,
      });
    });
  await projectDataService
    .failSession(env, target.projectId, target.chatSessionId, RUNTIME_RECOVERY_DEGRADED_MESSAGE)
    .catch((error) => {
      log.warn('vm_agent_container_recovery.chat_reconcile_failed', {
        nodeId: target.nodeId,
        workspaceId: target.workspaceId,
        error,
      });
    });
  return true;
}
