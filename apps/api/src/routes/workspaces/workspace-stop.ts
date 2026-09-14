import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { getUserId, requireApproved, requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { stopComputeTracking } from '../../services/compute-usage';
import { stopWorkspaceOnNode } from '../../services/node-agent';
import { stopNodeResources } from '../../services/nodes';
import * as projectDataService from '../../services/project-data';
import { deleteSessionSnapshotState } from '../../services/session-snapshots';
import { finalizeWorkspaceStopOnNode } from '../../services/workspace-eviction-lifecycle';
import {
  assertNodeOperational,
  getOwnedNode,
  getOwnedWorkspace,
  isActiveWorkspaceStatus,
} from './_helpers';

const workspaceStopRoutes = new Hono<{ Bindings: Env }>();
const CF_CONTAINER_STOPPABLE_WORKSPACE_STATUSES = new Set([
  'running',
  'recovery',
  'creating',
  'error',
  'stopping',
]);
const CF_CONTAINER_STOPPABLE_NODE_STATUSES = new Set(['running', 'creating', 'error']);

workspaceStopRoutes.post('/:id/stop', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!workspace.nodeId) {
    throw errors.badRequest('Workspace is not attached to a node');
  }
  const nodeId = workspace.nodeId;

  const node = await getOwnedNode(db, nodeId, userId);
  const isCfContainerNode = node.runtime === 'cf-container';
  const retryStopCleanup =
    !isCfContainerNode &&
    workspace.status === 'stopping' &&
    workspace.stopRuntimeConfirmedAt !== null;
  const canStopWorkspace =
    isActiveWorkspaceStatus(workspace.status) ||
    retryStopCleanup ||
    (isCfContainerNode && CF_CONTAINER_STOPPABLE_WORKSPACE_STATUSES.has(workspace.status));
  if (!canStopWorkspace) {
    throw errors.badRequest(`Workspace is ${workspace.status}`);
  }
  if (isCfContainerNode) {
    if (!CF_CONTAINER_STOPPABLE_NODE_STATUSES.has(node.status)) {
      throw errors.badRequest(`Cannot stop workspace: node is ${node.status}`);
    }
  } else if (!retryStopCleanup) {
    assertNodeOperational(node, 'stop workspace');
  }

  const claimedAt = new Date().toISOString();
  const stopIdentity = and(
    eq(schema.workspaces.id, workspace.id),
    eq(schema.workspaces.userId, userId),
    eq(schema.workspaces.nodeId, nodeId),
    sql`${schema.workspaces.projectId} IS ${workspace.projectId}`,
    sql`${schema.workspaces.chatSessionId} IS ${workspace.chatSessionId}`,
    sql`${schema.workspaces.evictionGeneration} IS ${workspace.evictionGeneration}`,
    sql`${schema.workspaces.runtimeDeletionConfirmedAt} IS NULL`
  );
  const stopClaim = and(
    stopIdentity,
    eq(schema.workspaces.status, 'stopping'),
    eq(schema.workspaces.updatedAt, claimedAt)
  );
  const claimed = await db
    .update(schema.workspaces)
    .set({
      status: 'stopping',
      updatedAt: claimedAt,
      stopRuntimeConfirmedAt: retryStopCleanup ? workspace.stopRuntimeConfirmedAt : null,
    })
    .where(
      and(
        stopIdentity,
        eq(schema.workspaces.status, workspace.status),
        eq(schema.workspaces.updatedAt, workspace.updatedAt)
      )
    )
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) {
    throw errors.conflict('Workspace changed while stop was being claimed');
  }

  c.executionCtx.waitUntil(
    (async () => {
      const innerDb = drizzle(c.env.DATABASE, { schema });
      let runtimeStopConfirmed = retryStopCleanup;
      try {
        if (isCfContainerNode) {
          if (workspace.chatSessionId) {
            await deleteSessionSnapshotState(innerDb, c.env, workspace.chatSessionId);
          }
          if (node.status === 'running' && isActiveWorkspaceStatus(workspace.status)) {
            await stopWorkspaceOnNode(nodeId, workspace.id, c.env, userId).catch((e) => {
              log.warn('workspace.cf_container_agent_stop_failed', {
                workspaceId: workspace.id,
                nodeId,
                error: String(e),
              });
            });
          }
          await stopNodeResources(nodeId, userId, c.env);
        } else {
          if (!retryStopCleanup) {
            await stopWorkspaceOnNode(nodeId, workspace.id, c.env, userId, {
              expectedEvictionGeneration: workspace.evictionGeneration ?? '',
              beforeExternalMutation: async () => {
                const current = await innerDb
                  .select({ id: schema.workspaces.id })
                  .from(schema.workspaces)
                  .where(stopClaim)
                  .get();
                if (!current) throw errors.conflict('Workspace stop lost its lifecycle claim');
              },
            });
            runtimeStopConfirmed = true;
            const confirmed = await innerDb
              .update(schema.workspaces)
              .set({ stopRuntimeConfirmedAt: new Date().toISOString() })
              .where(stopClaim)
              .run();
            if ((confirmed.meta.changes ?? 0) !== 1) return;
          }
          const finalized = await finalizeWorkspaceStopOnNode(c.env, {
            workspaceId: workspace.id,
            nodeId,
            generation: workspace.evictionGeneration,
            userId,
            projectId: workspace.projectId,
            chatSessionId: workspace.chatSessionId,
            claimedAt,
          });
          if (!finalized) return;

          // Schedule automatic deletion after TTL
          try {
            const doId = c.env.NODE_LIFECYCLE.idFromName(nodeId);
            const stub = c.env.NODE_LIFECYCLE.get(doId);
            await (
              stub as unknown as import('../../durable-objects/node-lifecycle').NodeLifecycle
            ).scheduleWorkspaceDeletion(nodeId, workspace.id, userId);
          } catch (e) {
            log.warn('workspace.schedule_deletion_failed', {
              workspaceId: workspace.id,
              error: String(e),
            });
          }
        }

        // Stop compute usage metering (best-effort)
        if (isCfContainerNode)
          await stopComputeTracking(innerDb, workspace.id).catch((e) => {
            log.warn('workspace.compute_tracking_stop_failed', {
              workspaceId: workspace.id,
              error: String(e),
            });
          });
      } catch (err) {
        await innerDb
          .update(schema.workspaces)
          .set({
            // A failed VM Stop may mean the eviction controller already stopped
            // the container and its callback is pending. Keep the prior active
            // state until that callback arrives; 'error' would allow unreserved restart.
            status: isCfContainerNode
              ? 'error'
              : runtimeStopConfirmed
                ? 'stopping'
                : workspace.status,
            ...(runtimeStopConfirmed ? { stopRuntimeConfirmedAt: new Date().toISOString() } : {}),
            errorMessage: err instanceof Error ? err.message : 'Failed to stop workspace',
            updatedAt: new Date().toISOString(),
          })
          .where(stopClaim);
      }
    })()
  );

  // Record activity event for workspace stop
  if (workspace.projectId) {
    c.executionCtx.waitUntil(
      projectDataService
        .recordActivityEvent(
          c.env,
          workspace.projectId,
          'workspace.stopped',
          'user',
          userId,
          workspace.id,
          null,
          null,
          null
        )
        .catch((e) => {
          log.warn('workspace.activity_stopped_failed', {
            workspaceId: workspace.id,
            error: String(e),
          });
        })
    );
  }

  return c.json({ status: 'stopping' });
});

export { workspaceStopRoutes };
