import { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../../index';
import { getUserId, requireAuth, requireApproved } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import * as schema from '../../db/schema';
import {
  rebuildWorkspaceOnNode,
  restartWorkspaceOnNode,
  stopWorkspaceOnNode,
} from '../../services/node-agent';
import { writeBootLogs } from '../../services/boot-log';
import * as projectDataService from '../../services/project-data';
import { log } from '../../lib/logger';
import {
  getOwnedWorkspace,
  getOwnedNode,
  assertNodeOperational,
  isActiveWorkspaceStatus,
  normalizeWorkspaceReadyStatus,
  verifyWorkspaceCallbackAuth,
} from './_helpers';

const lifecycleRoutes = new Hono<{ Bindings: Env }>();

// --- User-authenticated lifecycle routes ---

lifecycleRoutes.post('/:id/stop', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!workspace.nodeId) {
    throw errors.badRequest('Workspace is not attached to a node');
  }
  if (!isActiveWorkspaceStatus(workspace.status)) {
    throw errors.badRequest(`Workspace is ${workspace.status}`);
  }

  const node = await getOwnedNode(db, workspace.nodeId, userId);
  assertNodeOperational(node, 'stop workspace');

  await db
    .update(schema.workspaces)
    .set({ status: 'stopping', updatedAt: new Date().toISOString() })
    .where(eq(schema.workspaces.id, workspace.id));

  c.executionCtx.waitUntil(
    (async () => {
      const innerDb = drizzle(c.env.DATABASE, { schema });
      try {
        await stopWorkspaceOnNode(workspace.nodeId!, workspace.id, c.env, userId);
        await innerDb
          .update(schema.workspaces)
          .set({
            status: 'stopped',
            errorMessage: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.workspaces.id, workspace.id));
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

  // Stop the chat session and clean up activity tracking (best-effort)
  if (workspace.projectId && workspace.chatSessionId) {
    c.executionCtx.waitUntil(
      projectDataService.stopSession(c.env, workspace.projectId, workspace.chatSessionId)
        .catch((e) => { log.warn('workspace.stop_session_failed', { workspaceId: workspace.id, sessionId: workspace.chatSessionId, error: String(e) }); })
    );
    c.executionCtx.waitUntil(
      projectDataService.cleanupWorkspaceActivity(c.env, workspace.projectId, workspace.id)
        .catch((e) => { log.warn('workspace.cleanup_activity_failed', { workspaceId: workspace.id, error: String(e) }); })
    );
  }

  // Record activity event for workspace stop
  if (workspace.projectId) {
    c.executionCtx.waitUntil(
      projectDataService.recordActivityEvent(
        c.env, workspace.projectId, 'workspace.stopped', 'user', userId,
        workspace.id, null, null, null
      ).catch((e) => { log.warn('workspace.activity_stopped_failed', { workspaceId: workspace.id, error: String(e) }); })
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
  if (workspace.status !== 'stopped' && workspace.status !== 'error') {
    throw errors.badRequest(`Workspace is ${workspace.status}`);
  }

  const node = await getOwnedNode(db, workspace.nodeId, userId);
  assertNodeOperational(node, 'restart workspace');

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
        await restartWorkspaceOnNode(workspace.nodeId!, workspace.id, c.env, userId);
      } catch (err) {
        await innerDb
          .update(schema.workspaces)
          .set({
            status: 'error',
            errorMessage: err instanceof Error ? err.message : 'Failed to restart workspace',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.workspaces.id, workspace.id));
      }
    })()
  );

  // Record activity event for workspace restart
  if (workspace.projectId) {
    c.executionCtx.waitUntil(
      projectDataService.recordActivityEvent(
        c.env, workspace.projectId, 'workspace.restarted', 'user', userId,
        workspace.id, null, null, null
      ).catch((e) => { log.warn('workspace.activity_restarted_failed', { workspaceId: workspace.id, error: String(e) }); })
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
  if (!isActiveWorkspaceStatus(workspace.status) && workspace.status !== 'error') {
    throw errors.badRequest(
      `Workspace must be running, recovery, or in error state to rebuild, currently ${workspace.status}`
    );
  }

  const node = await getOwnedNode(db, workspace.nodeId, userId);
  assertNodeOperational(node, 'rebuild workspace');

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
        await rebuildWorkspaceOnNode(workspace.nodeId!, workspace.id, c.env, userId);
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
  const body = await c.req.json<{ status?: string }>().catch(
    (): { status?: string } => ({})
  );
  const nextStatus = normalizeWorkspaceReadyStatus(body.status);

  await verifyWorkspaceCallbackAuth(c, workspaceId);

  const rows = await db
    .select({ id: schema.workspaces.id, status: schema.workspaces.status })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = rows[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  if (workspace.status === 'stopping' || workspace.status === 'stopped') {
    return c.json({ success: false, reason: 'workspace_not_running' });
  }

  await db
    .update(schema.workspaces)
    .set({
      status: nextStatus,
      lastActivityAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.workspaces.id, workspaceId));

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
    const { advanceTaskRunnerWorkspaceReady } = await import('../../services/task-runner-do');
    const readyStatus = nextStatus === 'running' ? 'running'
      : nextStatus === 'recovery' ? 'recovery'
      : 'error';
    await advanceTaskRunnerWorkspaceReady(c.env, readyTask.id, readyStatus, null);
  }

  return c.json({ success: true });
});

lifecycleRoutes.post('/:id/provisioning-failed', async (c) => {
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  const body = await c.req.json<{ errorMessage?: string }>().catch(() => null);
  const providedMessage = typeof body?.errorMessage === 'string' ? body.errorMessage.trim() : '';
  const errorMessage = providedMessage || 'Workspace provisioning failed';

  const rows = await db
    .select({ status: schema.workspaces.status })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = rows[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  // Allow retries: if the workspace is already in 'error' state (from a previous
  // attempt where D1 was updated but the DO notification failed), skip the D1
  // update and retry the DO notification. Any other non-'creating' status is invalid.
  if (workspace.status === 'creating') {
    await db
      .update(schema.workspaces)
      .set({
        status: 'error',
        errorMessage,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workspaces.id, workspaceId));
  } else if (workspace.status !== 'error') {
    return c.json({ success: false, reason: 'workspace_not_creating' });
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
    const { advanceTaskRunnerWorkspaceReady } = await import('../../services/task-runner-do');
    await advanceTaskRunnerWorkspaceReady(c.env, failedTask.id, 'error', errorMessage);
  }

  return c.json({ success: true });
});

export { lifecycleRoutes };
