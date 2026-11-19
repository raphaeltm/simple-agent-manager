/**
 * One executor per Operations action. Each reuses the service function the UI and REST API
 * use for the same operation, so there is no parallel teardown path (policy 5cb362e8):
 *
 * | Action             | Shared function                                                  |
 * |--------------------|------------------------------------------------------------------|
 * | retry_snapshot     | `hibernateAgentSessionOnNode` (background checkpoint, no sleep)  |
 * | rerun_node_cleanup | clear the sweep backoff + `handOffEmptyWorkspaceNode`            |
 * | sleep_session      | `sleepWorkspaceSession` (the Sleep button)                       |
 * | delete_workspace   | `cleanupWorkspaceForDeletion` (the proof-bearing deletion queue) |
 * | delete_node        | `deleteOwnedNode` (strict provider teardown, the Delete button)  |
 * | restart_vm_agent   | `nodeAgentRequest` POST /admin/restart-agent                     |
 * | cancel_stuck_task  | `cancelTask` (the task Cancel control)                           |
 *
 * Each runs as the resource's OWNER, read from the row: the shared functions re-check
 * ownership against the user ID they are given, so passing the operator would be refused
 * or, for cleanup, silently skip the teardown.
 *
 * Executors never throw: every outcome, including an unexpected error, is a result the
 * caller records on the approval and audits.
 */
import type { OperationsAction } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { AppError } from '../../middleware/error';
import { deleteOwnedNode } from '../../routes/nodes/delete';
import { cancelTask } from '../cancel-task';
import {
  getNodeAgentBackgroundRequestTimeoutMs,
  hibernateAgentSessionOnNode,
  NodeAgentHttpError,
  nodeAgentRequest,
} from '../node-agent';
import { recordNodeLifecycleDecision } from '../node-lifecycle-decisions';
import { handOffEmptyWorkspaceNode } from '../node-warm-handoff';
import type { OperationsAccessContext } from '../operations-access';
import { listAcpSessions } from '../project-data';
import { isSafeSleepDeferral, sleepWorkspaceSession } from '../session-sleep';
import { cleanupWorkspaceForDeletion } from '../workspace-cleanup';
import type {
  ActionTarget,
  ChatSessionTarget,
  NodeTarget,
  TaskTarget,
  WorkspaceTarget,
} from './targets';

export type ActionExecutionStatus =
  /** The operation finished. */
  | 'succeeded'
  /** The operation was accepted and will finish asynchronously (queued snapshot, deletion retry). */
  | 'accepted'
  /** The target cannot take this action (wrong runtime, older agent, not running). */
  | 'unsupported'
  | 'failed';

export interface ActionExecutionResult {
  status: ActionExecutionStatus;
  message: string;
  detail?: Record<string, string | number | boolean | null>;
}

const ACP_SESSION_ACTIVE_STATUSES = new Set(['assigned', 'running']);

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function sessionWorkspace(target: ChatSessionTarget): WorkspaceTarget | ActionExecutionResult {
  return (
    target.workspace ?? {
      status: 'unsupported',
      message: `Chat session ${target.chatSessionId} has no running, recovering or sleeping workspace`,
    }
  );
}

async function retrySnapshot(env: Env, target: ChatSessionTarget): Promise<ActionExecutionResult> {
  const workspace = sessionWorkspace(target);
  if ('message' in workspace) return workspace;
  if (workspace.status !== 'running' || !workspace.nodeId || !workspace.projectId) {
    return {
      status: 'unsupported',
      message: `Workspace ${workspace.workspaceId} is ${workspace.status}; a snapshot needs a running workspace`,
    };
  }
  const { sessions } = await listAcpSessions(env, workspace.projectId, {
    chatSessionId: target.chatSessionId,
    limit: 20,
  });
  const acp = sessions.find(
    (session) =>
      ACP_SESSION_ACTIVE_STATUSES.has(session.status) &&
      session.acpSdkSessionId &&
      session.workspaceId === workspace.workspaceId
  );
  if (!acp?.acpSdkSessionId) {
    return {
      status: 'unsupported',
      message: `Chat session ${target.chatSessionId} has no live agent session on workspace ${workspace.workspaceId}`,
    };
  }
  await hibernateAgentSessionOnNode(
    workspace.nodeId,
    workspace.workspaceId,
    acp.acpSdkSessionId,
    env,
    workspace.ownerUserId,
    {
      chatSessionId: target.chatSessionId,
      runtime: workspace.nodeRuntime ?? 'vm',
      agentType: acp.agentType ?? undefined,
      background: true,
    }
  );
  return {
    status: 'accepted',
    message: 'Background snapshot queued; its step trace appears in ops_get_session_story',
    detail: { workspaceId: workspace.workspaceId, acpSessionId: acp.id },
  };
}

async function rerunNodeCleanup(env: Env, target: NodeTarget): Promise<ActionExecutionResult> {
  const { node } = target;
  // The backoff exists so one failing node cannot hot-loop the sweep (rule 47). An approved
  // rerun is a single, human- or matrix-gated retry, so clearing it once is bounded.
  const cleared = await env.DATABASE.prepare(
    `UPDATE nodes SET cleanup_backoff_until = NULL
      WHERE id = ? AND user_id = ? AND cleanup_backoff_until IS NOT NULL`
  )
    .bind(node.id, node.userId)
    .run();
  const backoffCleared = (cleared.meta?.changes ?? 0) > 0;
  await recordNodeLifecycleDecision(env.DATABASE, {
    nodeId: node.id,
    source: 'operations_action',
    decision: 'cleanup_rerun_requested',
    reason: backoffCleared ? 'cleanup backoff cleared' : 'no cleanup backoff was set',
  });
  const handoff = await handOffEmptyWorkspaceNode(env, {
    nodeId: node.id,
    expectedUserId: node.userId,
    reason: 'operations_rerun_node_cleanup',
  });
  const detail = {
    backoffCleared,
    handoff: handoff.outcome,
    handoffReason:
      handoff.outcome === 'skipped'
        ? handoff.reason
        : handoff.outcome === 'failed'
          ? handoff.error
          : null,
  };
  if (handoff.outcome === 'failed') {
    return { status: 'failed', message: `Warm handoff failed: ${handoff.error}`, detail };
  }
  return {
    status: 'succeeded',
    message:
      handoff.outcome === 'handed_to_warm'
        ? 'Node handed to warm retention; the lifecycle will retire it on its timer'
        : `Cleanup rerun requested; the next sweep retries the node (handoff ${handoff.outcome})`,
    detail,
  };
}

async function sleepSession(env: Env, target: ChatSessionTarget): Promise<ActionExecutionResult> {
  const workspace = sessionWorkspace(target);
  if ('message' in workspace) return workspace;
  try {
    const result = await sleepWorkspaceSession(env, {
      workspaceId: workspace.workspaceId,
      userId: workspace.ownerUserId,
      reason: 'Operations-approved session sleep',
    });
    return {
      status: 'succeeded',
      message: 'Session is asleep',
      detail: {
        workspaceId: result.workspaceId,
        snapshotExpiresAt: result.snapshotExpiresAt ?? null,
      },
    };
  } catch (error) {
    if (isSafeSleepDeferral(error)) return { status: 'unsupported', message: error.message };
    throw error;
  }
}

async function deleteWorkspace(env: Env, target: WorkspaceTarget): Promise<ActionExecutionResult> {
  const db = drizzle(env.DATABASE, { schema });
  const [workspace] = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, target.workspaceId))
    .limit(1);
  if (!workspace) return { status: 'failed', message: `Workspace ${target.workspaceId} is gone` };
  const outcome = await cleanupWorkspaceForDeletion({
    db,
    env,
    workspace,
    userId: workspace.userId,
    mode: 'explicit',
    logContext: { source: 'operations.delete_workspace' },
  });
  switch (outcome.status) {
    case 'confirmed':
      return { status: 'succeeded', message: 'Workspace deleted; runtime deletion confirmed' };
    case 'retry':
      return {
        status: 'accepted',
        message: `Deletion queued for retry: ${outcome.reason}`,
        detail: { reason: outcome.reason },
      };
    default:
      return {
        status: 'failed',
        message: `Deletion refused: ${outcome.reason}`,
        detail: { reason: outcome.reason },
      };
  }
}

async function deleteNode(env: Env, target: NodeTarget): Promise<ActionExecutionResult> {
  const db = drizzle(env.DATABASE, { schema });
  try {
    await deleteOwnedNode(env, db, target.node, target.node.userId);
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 409) {
      return { status: 'failed', message: error.message };
    }
    throw error;
  }
  return { status: 'succeeded', message: 'Node deleted; provider termination confirmed' };
}

async function restartVmAgent(
  env: Env,
  grant: OperationsAccessContext,
  target: NodeTarget
): Promise<ActionExecutionResult> {
  const { node } = target;
  if (node.runtime !== 'vm') {
    return {
      status: 'unsupported',
      message: `Node runtime ${node.runtime} has no restartable VM agent`,
    };
  }
  if (node.status !== 'running') {
    return { status: 'unsupported', message: `Node is ${node.status}, not running` };
  }
  try {
    // Signed for the gated operator, as the Operations node reach-in tools are; the agent
    // checks the token's node binding (node-scoped, no workspace claim).
    const response = await nodeAgentRequest(node.id, env, '/admin/restart-agent', {
      method: 'POST',
      userId: grant.userId,
      requestTimeoutMs: getNodeAgentBackgroundRequestTimeoutMs(env),
    });
    return {
      status: 'accepted',
      message: 'VM agent restart accepted; systemd starts a fresh agent',
      detail: {
        alreadyRequested:
          typeof response === 'object' && response !== null && 'alreadyRequested' in response
            ? Boolean((response as { alreadyRequested?: unknown }).alreadyRequested)
            : false,
      },
    };
  } catch (error) {
    // Rollout compatibility (rule 54): an agent built before the endpoint answers 404.
    if (error instanceof NodeAgentHttpError && error.statusCode === 404) {
      return {
        status: 'unsupported',
        message: 'This node runs a VM agent without restart support',
      };
    }
    if (error instanceof NodeAgentHttpError && error.statusCode === 409) {
      return {
        status: 'unsupported',
        message: 'The node agent refused a restart (standalone mode)',
      };
    }
    throw error;
  }
}

async function cancelStuckTask(env: Env, target: TaskTarget): Promise<ActionExecutionResult> {
  const db = drizzle(env.DATABASE, { schema });
  const [task] = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, target.taskId))
    .limit(1);
  if (!task) return { status: 'failed', message: `Task ${target.taskId} is gone` };
  // The owner, so task cleanup also tears down the owner's workspace (`requiredUserId`).
  const cancelled = await cancelTask(env, db, task, task.userId, {
    reason: 'Cancelled by an Operations-approved action (stuck task)',
    source: 'operations.cancel_stuck_task',
  });
  return {
    status: 'succeeded',
    message: `Task is ${cancelled.status}`,
    detail: { previousStatus: task.status, status: cancelled.status },
  };
}

/** Narrows a resolved target to the kind its action acts on (`OPERATIONS_ACTION_TARGET_TYPES`). */
function targetOf<K extends ActionTarget['kind']>(
  target: ActionTarget,
  kind: K
): Extract<ActionTarget, { kind: K }> {
  if (target.kind !== kind) throw new Error(`Expected a ${kind} target, got ${target.kind}`);
  return target as Extract<ActionTarget, { kind: K }>;
}

export async function executeAction(
  env: Env,
  grant: OperationsAccessContext,
  action: OperationsAction,
  target: ActionTarget
): Promise<ActionExecutionResult> {
  try {
    switch (action) {
      case 'retry_snapshot':
        return await retrySnapshot(env, targetOf(target, 'chat_session'));
      case 'rerun_node_cleanup':
        return await rerunNodeCleanup(env, targetOf(target, 'node'));
      case 'sleep_session':
        return await sleepSession(env, targetOf(target, 'chat_session'));
      case 'delete_workspace':
        return await deleteWorkspace(env, targetOf(target, 'workspace'));
      case 'delete_node':
        return await deleteNode(env, targetOf(target, 'node'));
      case 'restart_vm_agent':
        return await restartVmAgent(env, grant, targetOf(target, 'node'));
      case 'cancel_stuck_task':
        return await cancelStuckTask(env, targetOf(target, 'task'));
    }
  } catch (error) {
    return { status: 'failed', message: errorMessage(error) };
  }
}
