/**
 * Recording an Instant runtime whose in-place recovery was exhausted: the runtime
 * rows, the owning task and the ProjectData session all become terminal. Split out
 * of `vm-agent-container-recovery.ts` (`.claude/rules/18-file-size-limits.md`).
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import * as projectDataService from '../services/project-data';
import {
  RUNTIME_RECOVERY_DEGRADED_MESSAGE,
  type RuntimeRecoveryTarget,
} from './vm-agent-container-recovery';

const ACTIVE_TASK_STATUSES = ['in_progress', 'delegated', 'awaiting_followup'] as const;

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
