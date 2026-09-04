import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { getUserId, requireApproved, requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import {
  parseOptionalBody,
  WorkspaceErrorSchema,
  WorkspaceStatusUpdateSchema,
} from '../../schemas';
import { writeBootLogs } from '../../services/boot-log';
import { stopComputeTracking } from '../../services/compute-usage';
import {
  rebuildWorkspaceOnNode,
  restartWorkspaceOnNode,
  stopWorkspaceOnNode,
} from '../../services/node-agent';
import { stopNodeResources } from '../../services/nodes';
import * as projectDataService from '../../services/project-data';
import { sleepWorkspaceSession } from '../../services/session-sleep';
import { deleteSessionSnapshotState } from '../../services/session-snapshots';
import { finalizeWorkspaceLifecycleClosure } from '../../services/workspace-lifecycle-finalizer';
import { requireRepositoryOwnerAccess } from '../projects/_helpers';
import {
  assertNodeOperational,
  assertWorkspaceCallbackIdentityCurrent,
  assertWorkspaceCallbackResourceById,
  getOwnedNode,
  getOwnedWorkspace,
  isActiveWorkspaceStatus,
  normalizeWorkspaceReadyStatus,
  transitionWorkspaceFromCallback,
  verifyWorkspaceCallbackAuth,
  WORKSPACE_CALLBACK_PROVISIONING_FAILURE_STATUSES,
} from './_helpers';

const lifecycleRoutes = new Hono<{ Bindings: Env }>();
const CF_CONTAINER_STOPPABLE_WORKSPACE_STATUSES = new Set([
  'running',
  'recovery',
  'creating',
  'error',
  'stopping',
]);
const CF_CONTAINER_STOPPABLE_NODE_STATUSES = new Set(['running', 'creating', 'error']);
const SAFE_SLEEP_DEFERRAL_MESSAGES = new Set([
  'Harness-owned background work is active',
  'Workspace idle interval has not elapsed',
  'Workspace activity changed while the final snapshot was captured',
  'Workspace activity changed during snapshot artifact verification',
]);

function isSafeSleepDeferral(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  if (SAFE_SLEEP_DEFERRAL_MESSAGES.has(error.message)) return true;
  return error.message.startsWith('Workspace agent is not idle (');
}

function getTaskRunnerReadyStatus(status: string): 'running' | 'recovery' | 'error' {
  if (status === 'running') return 'running';
  if (status === 'recovery') return 'recovery';
  return 'error';
}

async function requireWorkspaceRestartGitHubAccess(
  env: Env,
  db: ReturnType<typeof drizzle<typeof schema>>,
  workspace: schema.Workspace,
  userId: string,
  flow: string
): Promise<void> {
  if (!workspace.projectId) return;
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(and(eq(schema.projects.id, workspace.projectId), eq(schema.projects.userId, userId)))
    .limit(1);
  if (!project) {
    throw errors.notFound('Project');
  }
  await requireRepositoryOwnerAccess(env, db, project, userId, flow);
}

// --- User-authenticated lifecycle routes ---

lifecycleRoutes.post('/:id/sleep', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  await getOwnedWorkspace(db, workspaceId, userId);
  const result = await sleepWorkspaceSession(c.env, {
    workspaceId,
    userId,
    reason: 'Explicit workspace sleep API request',
  }).catch((error) => {
    if (isSafeSleepDeferral(error)) {
      throw errors.conflict(error.message);
    }
    throw error;
  });
  return c.json(result);
});

lifecycleRoutes.post('/:id/stop', requireAuth(), requireApproved(), async (c) => {
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
  const canStopWorkspace =
    isActiveWorkspaceStatus(workspace.status) ||
    (isCfContainerNode && CF_CONTAINER_STOPPABLE_WORKSPACE_STATUSES.has(workspace.status));
  if (!canStopWorkspace) {
    throw errors.badRequest(`Workspace is ${workspace.status}`);
  }
  if (isCfContainerNode) {
    if (!CF_CONTAINER_STOPPABLE_NODE_STATUSES.has(node.status)) {
      throw errors.badRequest(`Cannot stop workspace: node is ${node.status}`);
    }
  } else {
    assertNodeOperational(node, 'stop workspace');
  }

  if (workspace.chatSessionId) {
    await deleteSessionSnapshotState(db, c.env, workspace.chatSessionId);
  }

  await db
    .update(schema.workspaces)
    .set({ status: 'stopping', updatedAt: new Date().toISOString() })
    .where(eq(schema.workspaces.id, workspace.id));

  c.executionCtx.waitUntil(
    (async () => {
      const innerDb = drizzle(c.env.DATABASE, { schema });
      try {
        if (isCfContainerNode) {
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
          await stopWorkspaceOnNode(nodeId, workspace.id, c.env, userId);
          const stoppedAt = new Date().toISOString();
          await innerDb
            .update(schema.workspaces)
            .set({
              status: 'stopped',
              errorMessage: null,
              updatedAt: stoppedAt,
            })
            .where(eq(schema.workspaces.id, workspace.id));

          await finalizeWorkspaceLifecycleClosure(c.env, {
            workspaceIds: [workspace.id],
            userId,
            agentSessionStatus: 'stopped',
            nowIso: stoppedAt,
            reason: 'workspace_stop',
          });

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
            status: 'error',
            errorMessage: err instanceof Error ? err.message : 'Failed to stop workspace',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.workspaces.id, workspace.id));
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

lifecycleRoutes.post('/:id/restart', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!workspace.nodeId) {
    throw errors.badRequest('Workspace is not attached to a node');
  }
  const nodeId = workspace.nodeId;
  if (workspace.status !== 'stopped' && workspace.status !== 'error') {
    throw errors.badRequest(`Workspace is ${workspace.status}`);
  }

  const node = await getOwnedNode(db, nodeId, userId);
  assertNodeOperational(node, 'restart workspace');
  await requireWorkspaceRestartGitHubAccess(c.env, db, workspace, userId, 'workspace-restart');

  // Fail closed: once a delete attempt is claimed, restart could create a
  // second live incarnation while the first delete is still in flight.
  const doId = c.env.NODE_LIFECYCLE.idFromName(nodeId);
  const stub = c.env.NODE_LIFECYCLE.get(doId);
  const cancelled = await (
    stub as unknown as import('../../durable-objects/node-lifecycle').NodeLifecycle
  ).cancelWorkspaceDeletion(workspace.id);
  if (!cancelled) {
    throw errors.conflict('Workspace deletion has already started; restart is fenced');
  }

  // Clear previous error state and boot logs before starting new provisioning
  const restartTransition = await db
    .update(schema.workspaces)
    .set({ status: 'creating', errorMessage: null, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(schema.workspaces.id, workspace.id),
        eq(schema.workspaces.userId, userId),
        eq(schema.workspaces.nodeId, nodeId),
        eq(schema.workspaces.status, workspace.status),
        sql`${schema.workspaces.projectId} IS ${workspace.projectId}`,
        sql`${schema.workspaces.chatSessionId} IS ${workspace.chatSessionId}`,
        sql`${schema.workspaces.runtimeDeletionConfirmedAt} IS NULL`
      )
    )
    .run();
  if ((restartTransition.meta.changes ?? 0) !== 1) {
    throw errors.conflict('Workspace changed while restart cancellation was being claimed');
  }
  await writeBootLogs(c.env.KV, workspace.id, [], c.env);

  c.executionCtx.waitUntil(
    (async () => {
      const innerDb = drizzle(c.env.DATABASE, { schema });
      try {
        await restartWorkspaceOnNode(nodeId, workspace.id, c.env, userId, {
          beforeExternalMutation: async () => {
            const current = await c.env.DATABASE.prepare(
              `SELECT id
                 FROM workspaces
                WHERE id = ?
                  AND user_id = ?
                  AND node_id = ?
                  AND project_id IS ?
                  AND chat_session_id IS ?
                  AND status = 'creating'
                  AND runtime_deletion_confirmed_at IS NULL
                LIMIT 1`
            )
              .bind(workspace.id, userId, nodeId, workspace.projectId, workspace.chatSessionId)
              .first<{ id: string }>();
            if (!current) throw new Error('Workspace restart lost its lifecycle claim');
          },
        });
      } catch (err) {
        await innerDb
          .update(schema.workspaces)
          .set({
            status: 'error',
            errorMessage: err instanceof Error ? err.message : 'Failed to restart workspace',
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              eq(schema.workspaces.id, workspace.id),
              eq(schema.workspaces.userId, userId),
              eq(schema.workspaces.nodeId, nodeId),
              eq(schema.workspaces.status, 'creating'),
              sql`${schema.workspaces.projectId} IS ${workspace.projectId}`,
              sql`${schema.workspaces.chatSessionId} IS ${workspace.chatSessionId}`,
              sql`${schema.workspaces.runtimeDeletionConfirmedAt} IS NULL`
            )
          );
      }
    })()
  );

  // Record activity event for workspace restart
  if (workspace.projectId) {
    c.executionCtx.waitUntil(
      projectDataService
        .recordActivityEvent(
          c.env,
          workspace.projectId,
          'workspace.restarted',
          'user',
          userId,
          workspace.id,
          null,
          null,
          null
        )
        .catch((e) => {
          log.warn('workspace.activity_restarted_failed', {
            workspaceId: workspace.id,
            error: String(e),
          });
        })
    );
  }

  return c.json({ status: 'creating' });
});

lifecycleRoutes.post('/:id/rebuild', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!workspace.nodeId) {
    throw errors.badRequest('Workspace is not attached to a node');
  }
  const nodeId = workspace.nodeId;
  if (!isActiveWorkspaceStatus(workspace.status) && workspace.status !== 'error') {
    throw errors.badRequest(
      `Workspace must be running, recovery, or in error state to rebuild, currently ${workspace.status}`
    );
  }

  const node = await getOwnedNode(db, nodeId, userId);
  assertNodeOperational(node, 'rebuild workspace');
  await requireWorkspaceRestartGitHubAccess(c.env, db, workspace, userId, 'workspace-rebuild');

  // Clear previous error state and boot logs before starting new provisioning
  await db
    .update(schema.workspaces)
    .set({ status: 'creating', errorMessage: null, updatedAt: new Date().toISOString() })
    .where(eq(schema.workspaces.id, workspace.id));
  await writeBootLogs(c.env.KV, workspace.id, [], c.env);

  c.executionCtx.waitUntil(
    (async () => {
      const innerDb = drizzle(c.env.DATABASE, { schema });
      try {
        await rebuildWorkspaceOnNode(nodeId, workspace.id, c.env, userId);
      } catch (err) {
        await innerDb
          .update(schema.workspaces)
          .set({
            status: 'error',
            errorMessage: err instanceof Error ? err.message : 'Failed to rebuild workspace',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.workspaces.id, workspace.id));
      }
    })()
  );

  return c.json({ status: 'rebuilding' }, 202);
});

// --- Callback-authenticated lifecycle routes ---

lifecycleRoutes.post('/:id/ready', async (c) => {
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  const body = await parseOptionalBody(c.req.raw, WorkspaceStatusUpdateSchema, {});
  const nextStatus = normalizeWorkspaceReadyStatus(body.status);

  await verifyWorkspaceCallbackAuth(c, workspaceId);

  const workspace = await assertWorkspaceCallbackResourceById(c.env, workspaceId, 'ready');
  const now = new Date().toISOString();
  const transitionedWorkspace = await transitionWorkspaceFromCallback(c.env, workspace, 'ready', {
    status: nextStatus,
    lastActivityAt: now,
    updatedAt: now,
    ...(body.workspaceProfile ? { workspaceProfile: body.workspaceProfile } : {}),
  });

  // Notify TaskRunner DO inline if a task is associated with this workspace.
  // TDF-5: moved from waitUntil() to inline await so the VM agent gets an error
  // response and retries (TDF-4) if the DO notification fails.
  const [readyTask] = await db
    .select({ id: schema.tasks.id, status: schema.tasks.status })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.workspaceId, workspaceId),
        inArray(schema.tasks.status, ['queued', 'delegated'])
      )
    )
    .limit(1);

  if (readyTask) {
    await assertWorkspaceCallbackIdentityCurrent(c.env, transitionedWorkspace, 'ready');
    const { advanceTaskRunnerWorkspaceReady } = await import('../../services/task-runner-do');
    const readyStatus = getTaskRunnerReadyStatus(nextStatus);
    await advanceTaskRunnerWorkspaceReady(c.env, readyTask.id, readyStatus, null);
  }

  return c.json({ success: true });
});

lifecycleRoutes.post('/:id/provisioning-failed', async (c) => {
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  const body = await parseOptionalBody(c.req.raw, WorkspaceErrorSchema, {});
  const providedMessage = typeof body.errorMessage === 'string' ? body.errorMessage.trim() : '';
  const errorMessage = providedMessage || 'Workspace provisioning failed';

  const workspace = await assertWorkspaceCallbackResourceById(
    c.env,
    workspaceId,
    'provisioning_failed',
    WORKSPACE_CALLBACK_PROVISIONING_FAILURE_STATUSES
  );

  // An error callback retry still performs an exact CAS. This keeps DO
  // notification retryability while ensuring deletion wins any interleaving.
  const transitionedWorkspace = await transitionWorkspaceFromCallback(
    c.env,
    workspace,
    'provisioning_failed',
    {
      status: 'error',
      errorMessage,
      updatedAt: new Date().toISOString(),
    },
    WORKSPACE_CALLBACK_PROVISIONING_FAILURE_STATUSES
  );
  if (workspace.status === 'creating') {
    await assertWorkspaceCallbackIdentityCurrent(
      c.env,
      transitionedWorkspace,
      'provisioning_failed',
      WORKSPACE_CALLBACK_PROVISIONING_FAILURE_STATUSES
    );
    // Stop compute metering on provisioning failure (best-effort)
    await stopComputeTracking(db, workspaceId).catch((e) => {
      log.warn('workspace.compute_tracking_stop_failed', { workspaceId, error: String(e) });
    });
  }

  // Notify TaskRunner DO of workspace error inline.
  // TDF-5: moved from waitUntil() to inline await so the VM agent gets an error
  // response and retries (TDF-4) if the DO notification fails.
  const [failedTask] = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.workspaceId, workspaceId),
        inArray(schema.tasks.status, ['queued', 'delegated'])
      )
    )
    .limit(1);

  if (failedTask) {
    await assertWorkspaceCallbackIdentityCurrent(
      c.env,
      transitionedWorkspace,
      'provisioning_failed',
      WORKSPACE_CALLBACK_PROVISIONING_FAILURE_STATUSES
    );
    const { advanceTaskRunnerWorkspaceReady } = await import('../../services/task-runner-do');
    await advanceTaskRunnerWorkspaceReady(c.env, failedTask.id, 'error', errorMessage);
  }

  return c.json({ success: true });
});

export { lifecycleRoutes };
