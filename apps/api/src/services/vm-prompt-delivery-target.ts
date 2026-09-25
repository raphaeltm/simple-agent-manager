/**
 * Resolving the runtime a durable prompt delivery targets, waking a sleeping
 * session when it has to. Split out of `vm-prompt-delivery-adapter.ts`
 * (`.claude/rules/18-file-size-limits.md`), which re-exports these types.
 */
import type { PromptDeliveryResult } from '../durable-objects/project-data/prompt-delivery';
import type { Env } from '../env';
import { ensureSessionRecovery } from './session-recovery';
import type { ProjectEventWakeRecoveryGuard } from './session-recovery-authority';

export interface VmPromptDeliveryTarget {
  projectId: string;
  chatSessionId: string;
  workspaceId: string;
  nodeId: string;
  agentSessionId: string;
  userId: string;
  runtimeIdentity: string;
  runtime: string;
}

export interface VmPromptDeliverySourceTaskGuard {
  taskId: string;
  projectId: string;
  chatSessionId: string;
  projectEventWake?: ProjectEventWakeRecoveryGuard | null;
  requiredProjectMemberId?: string | null;
}

export type TargetResolution =
  | { kind: 'ready'; target: VmPromptDeliveryTarget }
  | { kind: 'retry'; reason: string }
  | { kind: 'failed'; reason: 'terminal_target' | 'dead_target'; error: string }
  | { kind: 'guarded'; result: PromptDeliveryResult };

export async function resolveVmPromptDeliveryTarget(
  env: Env,
  projectId: string,
  chatSessionId: string,
  sourceTaskGuard: VmPromptDeliverySourceTaskGuard | undefined,
  runSideEffectGuard: () => Promise<PromptDeliveryResult | null>
): Promise<TargetResolution> {
  const row = await env.DATABASE.prepare(
    `SELECT w.id AS workspace_id,
            w.user_id AS user_id,
            w.status AS workspace_status,
            w.node_id AS node_id,
            n.status AS node_status,
            n.health_status AS node_health_status,
            n.agent_version AS agent_version,
            n.runtime AS node_runtime,
            a.id AS agent_session_id,
            a.status AS agent_session_status,
            a.updated_at AS agent_session_updated_at
     FROM workspaces w
     LEFT JOIN nodes n ON n.id = w.node_id
     LEFT JOIN agent_sessions a ON a.workspace_id = w.id
     WHERE w.project_id = ? AND w.chat_session_id = ?
     ORDER BY w.updated_at DESC, a.created_at DESC
     LIMIT 1`
  )
    .bind(projectId, chatSessionId)
    .first<{
      workspace_id: string;
      user_id: string;
      workspace_status: string;
      node_id: string | null;
      node_status: string | null;
      node_health_status: string | null;
      agent_version: string | null;
      node_runtime: string | null;
      agent_session_id: string | null;
      agent_session_status: string | null;
      agent_session_updated_at: string | null;
    }>();

  if (!row) {
    const guarded = await runSideEffectGuard();
    if (guarded) return { kind: 'guarded', result: guarded };
    const recovery = await ensureSessionRecovery(env, projectId, chatSessionId, sourceTaskGuard);
    if (recovery.status === 'waking') {
      return { kind: 'retry', reason: `Session is waking (${recovery.taskId})` };
    }
    return {
      kind: 'failed',
      reason: 'terminal_target',
      error: `Target workspace no longer exists (${recovery.reason})`,
    };
  }
  if (
    row.node_runtime !== 'cf-container' &&
    ['sleeping', 'stopping', 'stopped', 'deleted', 'error'].includes(row.workspace_status)
  ) {
    const guarded = await runSideEffectGuard();
    if (guarded) return { kind: 'guarded', result: guarded };
    const recovery = await ensureSessionRecovery(env, projectId, chatSessionId, sourceTaskGuard);
    if (recovery.status === 'waking') {
      return { kind: 'retry', reason: `Session is waking (${recovery.taskId})` };
    }
    return {
      kind: 'failed',
      reason: 'terminal_target',
      error: `Target workspace is ${row.workspace_status} (${recovery.reason})`,
    };
  }
  if (['stopping', 'stopped', 'evicted', 'deleted', 'error'].includes(row.workspace_status)) {
    return {
      kind: 'failed',
      reason: 'terminal_target',
      error: `Target workspace is ${row.workspace_status}`,
    };
  }
  if (!row.node_id) {
    return { kind: 'retry', reason: 'Target workspace has no assigned node yet' };
  }
  if (
    ['stopping', 'stopped', 'deleted', 'error'].includes(row.node_status ?? '') ||
    row.node_health_status === 'unhealthy'
  ) {
    return { kind: 'failed', reason: 'dead_target', error: 'Target node is unavailable' };
  }
  const wakeableStatuses = ['running', 'recovery', 'sleeping'];
  if (
    !wakeableStatuses.includes(row.workspace_status) ||
    !wakeableStatuses.includes(row.node_status ?? '')
  ) {
    return {
      kind: 'retry',
      reason: `Target runtime is not ready (${row.workspace_status}/${row.node_status ?? 'unknown'})`,
    };
  }
  if (!row.agent_session_id) {
    return { kind: 'retry', reason: 'Target agent session has not started yet' };
  }
  if (row.agent_session_status !== 'running') {
    if (['completed', 'failed', 'error', 'stopped'].includes(row.agent_session_status ?? '')) {
      return {
        kind: 'failed',
        reason: 'terminal_target',
        error: `Target agent session is ${row.agent_session_status}`,
      };
    }
    return { kind: 'retry', reason: `Target agent session is ${row.agent_session_status}` };
  }

  return {
    kind: 'ready',
    target: {
      projectId,
      chatSessionId,
      workspaceId: row.workspace_id,
      nodeId: row.node_id,
      agentSessionId: row.agent_session_id,
      userId: row.user_id,
      runtimeIdentity: [
        row.node_id,
        row.agent_session_id,
        row.agent_version ?? 'legacy',
        row.agent_session_updated_at ?? 'unknown',
      ].join(':'),
      runtime: row.node_runtime ?? 'vm',
    },
  };
}
