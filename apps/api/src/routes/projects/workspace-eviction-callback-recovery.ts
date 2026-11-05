/**
 * Recovery half of the workspace eviction callback (`workspace-eviction-callback.ts`): publish
 * the recovery artifact, finalize the eviction on its node, then start the durable wake.
 */
import type { Context } from 'hono';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { errors } from '../../middleware/error';
import * as projectDataService from '../../services/project-data';
import { classifySessionRecoveryRefusal } from '../../services/session-recovery-refusals';
import { finalizeWorkspaceEvictionOnNode } from '../../services/workspace-eviction-lifecycle';
import {
  markEvictedWorkspaceSnapshotSleeping,
  recoverWorkspaceAfterEviction,
} from '../../services/workspace-eviction-recovery';
import type {
  WorkspaceEvictionBody,
  WorkspaceEvictionResource,
} from './workspace-eviction-callback';

function evictionRecoveryReasonIsRetryable(reason: string): boolean {
  return classifySessionRecoveryRefusal(reason).action === 'retry';
}

async function finalizeEvictionLifecycle(env: Env, workspace: WorkspaceEvictionResource) {
  if (
    !workspace.nodeId ||
    !(await finalizeWorkspaceEvictionOnNode(env, {
      nodeId: workspace.nodeId,
      workspaceId: workspace.workspaceId,
      generation: workspace.evictionGeneration,
    }))
  ) {
    throw errors.gone('Workspace eviction identity changed before cleanup');
  }
}

/** Publish the same recovery artifact the finalizer reads before it can stop the chat. */
async function prepareEvictedWorkspaceRecovery(
  env: Env,
  workspace: WorkspaceEvictionResource,
  body: WorkspaceEvictionBody,
  projectId: string,
  snapshotMarked?: boolean
): Promise<void> {
  if (!body.snapshotCaptured || !workspace.chatSessionId) return;
  const marked =
    snapshotMarked ??
    (await markEvictedWorkspaceSnapshotSleeping(env, {
      projectId,
      workspaceId: workspace.workspaceId,
      chatSessionId: workspace.chatSessionId,
      nodeId: body.nodeId,
      generation: body.evictionGeneration ?? null,
      interruptedWork: body.interruptedWork,
    }));
  if (!marked) return;
  const session = await projectDataService.getSession(env, projectId, workspace.chatSessionId);
  if (session?.status === 'active' && session.workspaceId === workspace.workspaceId) {
    await projectDataService.sleepSession(env, projectId, workspace.chatSessionId, {
      guard: {
        taskId: typeof session.taskId === 'string' ? session.taskId : null,
        workspaceId: workspace.workspaceId,
      },
    });
  }
}

async function recoverEvictedWorkspace(
  env: Env,
  workspace: WorkspaceEvictionResource,
  body: WorkspaceEvictionBody,
  projectId: string
): Promise<void> {
  if (!body.snapshotCaptured || !workspace.chatSessionId) return;
  const recovery = await recoverWorkspaceAfterEviction(env, {
    projectId,
    workspaceId: workspace.workspaceId,
    chatSessionId: workspace.chatSessionId,
    nodeId: body.nodeId,
    generation: body.evictionGeneration ?? null,
    interruptedWork: body.interruptedWork,
  });
  if (recovery.status === 'unavailable') {
    log.warn('workspace_eviction.recovery_deferred', {
      projectId,
      workspaceId: workspace.workspaceId,
      nodeId: body.nodeId,
      reason: recovery.reason,
    });
    if (evictionRecoveryReasonIsRetryable(recovery.reason)) {
      throw errors.conflict(`Evicted workspace recovery is not ready: ${recovery.reason}`);
    }
  }
}

/**
 * Publish, finalize and wake as one unit that outlives the callback's client. The VM agent's
 * callback client gives up after its own timeout and the Workers runtime then cancels any
 * unregistered work, so a wake cut off between its snapshot claim and its TaskRunner start
 * strands the conversation: the VM's retry inside the claim lease sees the claim as in flight
 * and stops retrying (staging, 2026-11-05). `waitUntil` keeps the work alive after the client
 * disconnects; the response still waits for it, so a retryable refusal still reaches the VM.
 */
export function completeEvictionRecovery(
  c: Context<{ Bindings: Env }>,
  workspace: WorkspaceEvictionResource,
  body: WorkspaceEvictionBody,
  projectId: string,
  recovery: { evicted: WorkspaceEvictionResource; snapshotMarked?: boolean }
): Promise<void> {
  const work = (async () => {
    await prepareEvictedWorkspaceRecovery(
      c.env,
      workspace,
      body,
      projectId,
      recovery.snapshotMarked
    );
    await finalizeEvictionLifecycle(c.env, workspace);
    await recoverEvictedWorkspace(c.env, recovery.evicted, body, projectId);
  })();
  c.executionCtx.waitUntil(work.catch(() => undefined));
  return work;
}
