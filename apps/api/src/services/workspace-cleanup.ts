import { and, eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { stopComputeTracking } from './compute-usage';
import { deleteWorkspaceOnNode } from './node-agent';
import * as projectDataService from './project-data';

type Db = ReturnType<typeof drizzle<typeof schema>>;

type WaitUntil = (promise: Promise<unknown>) => void;

export interface WorkspaceDeletionCleanupOptions {
  db: Db;
  env: Env;
  workspace: schema.Workspace;
  userId: string;
  waitUntil?: WaitUntil;
  logContext?: Record<string, unknown>;
}

export async function cleanupWorkspaceForDeletion(options: WorkspaceDeletionCleanupOptions): Promise<void> {
  const { db, env, workspace, userId, waitUntil, logContext = {} } = options;

  if (workspace.nodeId) {
    const [node] = await db
      .select({
        status: schema.nodes.status,
        healthStatus: schema.nodes.healthStatus,
      })
      .from(schema.nodes)
      .where(and(eq(schema.nodes.id, workspace.nodeId), eq(schema.nodes.userId, userId)))
      .limit(1);

    if (node?.status === 'running' && node.healthStatus !== 'unhealthy') {
      try {
        await deleteWorkspaceOnNode(workspace.nodeId, workspace.id, env, userId);
      } catch (e) {
        log.error('workspace.delete_on_node_failed', {
          workspaceId: workspace.id,
          nodeId: workspace.nodeId,
          error: String(e),
          ...logContext,
        });
      }
    }
  }

  if (workspace.projectId && workspace.chatSessionId) {
    const stopSession = projectDataService.stopSession(env, workspace.projectId, workspace.chatSessionId)
      .catch((e) => {
        log.warn('workspace.delete_stop_session_failed', {
          workspaceId: workspace.id,
          sessionId: workspace.chatSessionId,
          error: String(e),
          ...logContext,
        });
      });
    const cleanupActivity = projectDataService.cleanupWorkspaceActivity(env, workspace.projectId, workspace.id)
      .catch((e) => {
        log.warn('workspace.delete_cleanup_activity_failed', {
          workspaceId: workspace.id,
          error: String(e),
          ...logContext,
        });
      });

    if (waitUntil) {
      waitUntil(stopSession);
      waitUntil(cleanupActivity);
    } else {
      await Promise.all([stopSession, cleanupActivity]);
    }
  }

  try {
    await stopComputeTracking(db, workspace.id);
  } catch (e) {
    log.warn('workspace.compute_tracking_stop_failed', {
      workspaceId: workspace.id,
      error: String(e),
      ...logContext,
    });
  }

  await db.delete(schema.agentSessions).where(eq(schema.agentSessions.workspaceId, workspace.id));

  await db
    .delete(schema.workspaces)
    .where(and(eq(schema.workspaces.id, workspace.id), eq(schema.workspaces.userId, userId)));
}
