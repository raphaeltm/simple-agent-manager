import { and, eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { deleteWorkspaceOnNode } from './node-agent';
import { stopNodeResources } from './nodes';
import { deleteSessionSnapshotState } from './session-snapshots';
import { finalizeWorkspaceLifecycleClosure } from './workspace-lifecycle-finalizer';

type Db = ReturnType<typeof drizzle<typeof schema>>;

type WaitUntil = (promise: Promise<unknown>) => void;
type WorkspaceNodeCleanupNode = {
  status: string;
  healthStatus: string | null;
  runtime: string | null;
};

export interface WorkspaceDeletionCleanupOptions {
  db: Db;
  env: Env;
  workspace: schema.Workspace;
  userId: string;
  waitUntil?: WaitUntil;
  logContext?: Record<string, unknown>;
}

function logWorkspaceNodeCleanupFailure(
  workspace: schema.Workspace,
  node: WorkspaceNodeCleanupNode,
  error: unknown,
  logContext: Record<string, unknown>
): void {
  log.error('workspace.delete_on_node_failed', {
    workspaceId: workspace.id,
    nodeId: workspace.nodeId,
    runtime: node.runtime,
    error: String(error),
    ...logContext,
  });
}

async function cleanupWorkspaceNode(options: {
  env: Env;
  workspace: schema.Workspace;
  userId: string;
  node: WorkspaceNodeCleanupNode;
  logContext: Record<string, unknown>;
}): Promise<void> {
  const { env, workspace, userId, node, logContext } = options;
  if (!workspace.nodeId) return;

  try {
    if (node.runtime === 'cf-container' && node.status !== 'deleted') {
      await stopNodeResources(workspace.nodeId, userId, env);
      return;
    }
    if (node.status === 'running' && node.healthStatus !== 'unhealthy') {
      await deleteWorkspaceOnNode(workspace.nodeId, workspace.id, env, userId);
    }
  } catch (error) {
    logWorkspaceNodeCleanupFailure(workspace, node, error, logContext);
  }
}

export async function cleanupWorkspaceForDeletion(
  options: WorkspaceDeletionCleanupOptions
): Promise<void> {
  const { db, env, workspace, userId, logContext = {} } = options;

  if (workspace.chatSessionId) {
    await deleteSessionSnapshotState(db, env, workspace.chatSessionId);
  }

  if (workspace.nodeId) {
    const [node] = await db
      .select({
        status: schema.nodes.status,
        healthStatus: schema.nodes.healthStatus,
        runtime: schema.nodes.runtime,
      })
      .from(schema.nodes)
      .where(and(eq(schema.nodes.id, workspace.nodeId), eq(schema.nodes.userId, userId)))
      .limit(1);

    if (node) {
      await cleanupWorkspaceNode({ env, workspace, userId, node, logContext });
    }
  }

  await finalizeWorkspaceLifecycleClosure(env, {
    workspaceIds: [workspace.id],
    userId,
    agentSessionStatus: 'completed',
    reason: String(logContext.closePath ?? 'workspace_delete'),
  });

  await db
    .delete(schema.workspaces)
    .where(and(eq(schema.workspaces.id, workspace.id), eq(schema.workspaces.userId, userId)));
}
