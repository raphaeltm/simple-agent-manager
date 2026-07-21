import { and, desc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import * as projectDataService from '../services/project-data';

export const RUNTIME_RECOVERING_MESSAGE =
  'Instant session interrupted; restoring the last safe checkpoint.';
export const RUNTIME_REQUEST_INTERRUPTED_MESSAGE =
  'Your message is saved, but the Instant runtime changed while it was being sent. It was not replayed automatically. Wait for restore to finish, then send it again.';
export const RUNTIME_RECOVERY_DEGRADED_MESSAGE =
  'The Instant session could not restore its last safe checkpoint. Your transcript and partial output are still available.';
export const RUNTIME_STOPPED_MESSAGE = 'This Instant session was stopped and cannot be resumed.';

export type RuntimeRecoveryCode =
  | 'RUNTIME_RECOVERING'
  | 'RUNTIME_REQUEST_INTERRUPTED'
  | 'RUNTIME_RECOVERY_DEGRADED'
  | 'RUNTIME_STOPPED';

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
  projectId: string;
  chatSessionId: string;
  agentSessionId: string;
}

export interface RuntimeRecoveryContext {
  userId: string;
  chatSessionId: string;
  agentSessionId: string;
  agentType: string | null;
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
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, input.workspaceId))
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
  };
}

export async function persistRuntimeRecovering(
  env: Env,
  target: RuntimeRecoveryTarget
): Promise<void> {
  const now = new Date().toISOString();
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE nodes
       SET status = 'recovery', health_status = 'unhealthy', error_message = ?, updated_at = ?
       WHERE id = ?`
    ).bind(RUNTIME_RECOVERING_MESSAGE, now, target.nodeId),
    env.DATABASE.prepare(
      `UPDATE workspaces SET status = 'recovery', error_message = ?, updated_at = ? WHERE id = ?`
    ).bind(RUNTIME_RECOVERING_MESSAGE, now, target.workspaceId),
    env.DATABASE.prepare(
      `UPDATE agent_sessions
       SET status = 'recovery', stopped_at = NULL, error_message = ?, updated_at = ?
       WHERE id = ?`
    ).bind(RUNTIME_RECOVERING_MESSAGE, now, target.agentSessionId),
  ]);
}

export async function persistRuntimeRecovered(
  env: Env,
  target: RuntimeRecoveryTarget,
  promptDisposition: RuntimeRecoveryState['promptDisposition']
): Promise<void> {
  const now = new Date().toISOString();
  const agentMessage =
    promptDisposition === 'manual_retry' ? RUNTIME_REQUEST_INTERRUPTED_MESSAGE : null;
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE nodes
       SET status = 'running', health_status = 'healthy', error_message = NULL, updated_at = ?
       WHERE id = ?`
    ).bind(now, target.nodeId),
    env.DATABASE.prepare(
      `UPDATE workspaces SET status = 'running', error_message = NULL, updated_at = ? WHERE id = ?`
    ).bind(now, target.workspaceId),
    env.DATABASE.prepare(
      `UPDATE agent_sessions
       SET status = 'running', stopped_at = NULL, error_message = ?, updated_at = ?
       WHERE id = ?`
    ).bind(agentMessage, now, target.agentSessionId),
  ]);
}

export async function persistRuntimeRecoveryFailed(
  env: Env,
  target: RuntimeRecoveryTarget
): Promise<void> {
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
       WHERE id = ?`
    ).bind(RUNTIME_RECOVERY_DEGRADED_MESSAGE, now, target.nodeId),
    env.DATABASE.prepare(
      `UPDATE workspaces SET status = 'error', error_message = ?, updated_at = ? WHERE id = ?`
    ).bind(RUNTIME_RECOVERY_DEGRADED_MESSAGE, now, target.workspaceId),
    env.DATABASE.prepare(
      `UPDATE agent_sessions
       SET status = 'error', stopped_at = ?, error_message = ?, updated_at = ?
       WHERE id = ?`
    ).bind(now, RUNTIME_RECOVERY_DEGRADED_MESSAGE, now, target.agentSessionId),
  ];

  if (task) {
    statements.push(
      env.DATABASE.prepare(
        `INSERT INTO task_status_events
           (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
         SELECT ?, id, status, 'failed', 'system', ?, ?, ?
         FROM tasks
         WHERE id = ? AND status IN ('in_progress', 'delegated', 'awaiting_followup')`
      ).bind(ulid(), target.nodeId, 'Instant runtime recovery exhausted', now, task.id),
      env.DATABASE.prepare(
        `UPDATE tasks
         SET status = 'failed', execution_step = NULL, error_message = ?, updated_at = ?
         WHERE id = ? AND status IN ('in_progress', 'delegated', 'awaiting_followup')`
      ).bind(RUNTIME_RECOVERY_DEGRADED_MESSAGE, now, task.id)
    );
  }

  await env.DATABASE.batch(statements);

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
}
