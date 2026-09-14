import type { CapacityPlacementSnapshot } from '@simple-agent-manager/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { getUserId, requireApproved, requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import {
  parseOptionalBody,
  WorkspaceErrorSchema,
  WorkspaceStatusUpdateSchema,
} from '../../schemas';
import { writeBootLogs } from '../../services/boot-log';
import { stopComputeTracking } from '../../services/compute-usage';
import { rebuildWorkspaceOnNode, restartWorkspaceOnNode } from '../../services/node-agent';
import * as projectDataService from '../../services/project-data';
import { sleepWorkspaceSession } from '../../services/session-sleep';
import { finalizeWorkspaceEvictionOnNode } from '../../services/workspace-eviction-lifecycle';
import { reserveEvictedWorkspaceRestart } from '../../services/workspace-placement';
import {
  parseResolvedResourceReservation,
  resolveWorkspaceAdmissionPolicy,
} from '../../services/workspace-resource-capacity';
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
import { startComputeTrackingForNode } from './workspace-create-helpers';
import { workspaceStopRoutes } from './workspace-stop';

const lifecycleRoutes = new Hono<{ Bindings: Env }>();
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

type WorkspaceRuntimeRecreationOperation = 'restart' | 'rebuild';

class WorkspaceRuntimeRecreationFenceError extends Error {
  constructor(readonly operation: WorkspaceRuntimeRecreationOperation) {
    super(`Workspace ${operation} lost its lifecycle claim`);
    this.name = 'WorkspaceRuntimeRecreationFenceError';
  }
}

async function recordWorkspaceRuntimeRecreationFailure(
  env: Env,
  db: ReturnType<typeof drizzle<typeof schema>>,
  workspace: schema.Workspace,
  userId: string,
  nodeId: string,
  operation: WorkspaceRuntimeRecreationOperation,
  evictionGeneration: string,
  error: unknown,
  runtimeDispatchStarted?: boolean
): Promise<void> {
  const result = await db
    .update(schema.workspaces)
    .set({
      // An uncertain dispatch must retain admission and billing until the VM
      // reports its outcome. Before dispatch, the original eviction is retryable.
      status:
        workspace.status === 'evicted'
          ? runtimeDispatchStarted
            ? 'creating'
            : 'evicted'
          : 'error',
      ...(workspace.status === 'evicted' && !runtimeDispatchStarted
        ? {
            evictionGeneration: workspace.evictionGeneration,
            evictionFinalizedAt: workspace.evictionFinalizedAt,
            stopRuntimeConfirmedAt: workspace.stopRuntimeConfirmedAt,
          }
        : {}),
      errorMessage: error instanceof Error ? error.message : `Failed to ${operation} workspace`,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(schema.workspaces.id, workspace.id),
        eq(schema.workspaces.userId, userId),
        eq(schema.workspaces.nodeId, nodeId),
        eq(schema.workspaces.status, 'creating'),
        eq(schema.workspaces.evictionGeneration, evictionGeneration),
        sql`${schema.workspaces.projectId} IS ${workspace.projectId}`,
        sql`${schema.workspaces.chatSessionId} IS ${workspace.chatSessionId}`,
        sql`${schema.workspaces.runtimeDeletionConfirmedAt} IS NULL`
      )
    )
    .run();

  if (error instanceof WorkspaceRuntimeRecreationFenceError || (result.meta.changes ?? 0) === 0) {
    const current = await env.DATABASE.prepare(
      `SELECT user_id AS userId,
              project_id AS projectId,
              chat_session_id AS chatSessionId,
              node_id AS nodeId,
              status,
              runtime_deletion_confirmed_at AS runtimeDeletionConfirmedAt
         FROM workspaces
        WHERE id = ?
        LIMIT 1`
    )
      .bind(workspace.id)
      .first<{
        userId: string;
        projectId: string | null;
        chatSessionId: string | null;
        nodeId: string | null;
        status: string;
        runtimeDeletionConfirmedAt: string | null;
      }>();
    log.warn('workspace_runtime_recreation.identity_fenced', {
      workspaceId: workspace.id,
      operation,
      expectedUserId: userId,
      currentUserId: current?.userId ?? null,
      expectedProjectId: workspace.projectId,
      currentProjectId: current?.projectId ?? null,
      expectedChatSessionId: workspace.chatSessionId,
      currentChatSessionId: current?.chatSessionId ?? null,
      expectedNodeId: nodeId,
      currentNodeId: current?.nodeId ?? null,
      expectedStatus: 'creating',
      currentStatus: current?.status ?? 'missing',
      currentRuntimeDeletionConfirmedAt: current?.runtimeDeletionConfirmedAt ?? null,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      action:
        error instanceof WorkspaceRuntimeRecreationFenceError
          ? 'network_request_refused'
          : 'error_state_update_refused',
    });
  }
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

lifecycleRoutes.route('/', workspaceStopRoutes);

lifecycleRoutes.post('/:id/restart', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!workspace.nodeId) {
    throw errors.badRequest('Workspace is not attached to a node');
  }
  const nodeId = workspace.nodeId;
  const evictionGeneration = ulid();
  if (!['stopped', 'error', 'evicted'].includes(workspace.status)) {
    throw errors.badRequest(`Workspace is ${workspace.status}`);
  }

  const node = await getOwnedNode(db, nodeId, userId);
  assertNodeOperational(node, 'restart workspace');
  await requireWorkspaceRestartGitHubAccess(c.env, db, workspace, userId, 'workspace-restart');

  if (
    workspace.status === 'evicted' &&
    node.credentialSource === 'platform' &&
    c.env.COMPUTE_QUOTA_ENFORCEMENT_ENABLED !== 'false'
  ) {
    const { checkQuotaForUser } = await import('../../services/compute-quotas');
    if (!(await checkQuotaForUser(db, userId)).allowed) {
      throw errors.forbidden('Monthly compute quota exceeded');
    }
  }

  if (
    workspace.status === 'evicted' &&
    !(await finalizeWorkspaceEvictionOnNode(c.env, {
      nodeId,
      workspaceId: workspace.id,
      generation: workspace.evictionGeneration,
    }))
  ) {
    throw errors.conflict('Workspace eviction changed before restart cleanup');
  }

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
  const restartTransition =
    workspace.status === 'evicted'
      ? {
          meta: {
            changes:
              workspace.projectId &&
              (await reserveEvictedWorkspaceRestart(
                c.env.DATABASE,
                {
                  id: workspace.id,
                  nodeId,
                  userId,
                  projectId: workspace.projectId,
                  chatSessionId: workspace.chatSessionId,
                  evictionGeneration,
                  expectedEvictionGeneration: workspace.evictionGeneration,
                  resolvedReservation: parseResolvedResourceReservation(
                    workspace.resolvedReservationJson
                  ),
                  // The shared admission SQL validates the persisted pool/source/credential
                  // snapshot against current authority before permitting the same-node restart.
                  capacityPlacementSnapshot: node as unknown as CapacityPlacementSnapshot,
                  authorityNodeClass: node.nodeClass === 'user-owned' ? 'user-owned' : 'managed',
                },
                resolveWorkspaceAdmissionPolicy(c.env)
              ))
                ? 1
                : 0,
          },
        }
      : await db
          .update(schema.workspaces)
          .set({
            status: 'creating',
            errorMessage: null,
            updatedAt: new Date().toISOString(),
            evictionGeneration,
            evictionFinalizedAt: null,
            stopRuntimeConfirmedAt: null,
          })
          .where(
            and(
              eq(schema.workspaces.id, workspace.id),
              eq(schema.workspaces.userId, userId),
              eq(schema.workspaces.nodeId, nodeId),
              eq(schema.workspaces.status, workspace.status),
              sql`${schema.workspaces.evictionGeneration} IS ${workspace.evictionGeneration}`,
              sql`${schema.workspaces.projectId} IS ${workspace.projectId}`,
              sql`${schema.workspaces.chatSessionId} IS ${workspace.chatSessionId}`,
              sql`${schema.workspaces.runtimeDeletionConfirmedAt} IS NULL`
            )
          )
          .run();
  if ((restartTransition.meta.changes ?? 0) !== 1) {
    throw errors.conflict(
      workspace.status === 'evicted'
        ? 'Workspace restart requires current compute authority and available node capacity'
        : 'Workspace changed while restart cancellation was being claimed'
    );
  }
  const computeUsageId = `evicted-restart:${workspace.id}:${evictionGeneration}`;
  c.executionCtx.waitUntil(
    (async () => {
      const innerDb = drizzle(c.env.DATABASE, { schema });
      let runtimeDispatchStarted = false;
      try {
        await writeBootLogs(c.env.KV, workspace.id, [], c.env);
        if (workspace.status === 'evicted') {
          await startComputeTrackingForNode(innerDb, {
            userId,
            workspaceId: workspace.id,
            nodeId,
            vmSize: workspace.vmSize,
            idempotencyKey: computeUsageId,
            propagateFailure: true,
          });
        }
        await restartWorkspaceOnNode(nodeId, workspace.id, c.env, userId, {
          evictionGeneration,
          expectedEvictionGeneration: workspace.evictionGeneration ?? '',
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
                  AND eviction_generation = ?
                  AND runtime_deletion_confirmed_at IS NULL
                LIMIT 1`
            )
              .bind(
                workspace.id,
                userId,
                nodeId,
                workspace.projectId,
                workspace.chatSessionId,
                evictionGeneration
              )
              .first<{ id: string }>();
            if (!current) throw new WorkspaceRuntimeRecreationFenceError('restart');
            runtimeDispatchStarted = true;
          },
        });
      } catch (err) {
        if (workspace.status === 'evicted' && !runtimeDispatchStarted) {
          await innerDb
            .update(schema.computeUsage)
            .set({ endedAt: new Date().toISOString() })
            .where(
              and(
                eq(schema.computeUsage.id, computeUsageId),
                sql`${schema.computeUsage.endedAt} IS NULL`
              )
            )
            .run()
            .catch((cleanupError) => {
              log.warn('workspace.evicted_restart_compute_tracking_stop_failed', {
                workspaceId: workspace.id,
                error: String(cleanupError),
              });
            });
        }
        await recordWorkspaceRuntimeRecreationFailure(
          c.env,
          innerDb,
          workspace,
          userId,
          nodeId,
          'restart',
          evictionGeneration,
          err,
          runtimeDispatchStarted
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
  const evictionGeneration = ulid();
  if (!isActiveWorkspaceStatus(workspace.status) && workspace.status !== 'error') {
    throw errors.badRequest(
      `Workspace must be running, recovery, or in error state to rebuild, currently ${workspace.status}`
    );
  }

  const node = await getOwnedNode(db, nodeId, userId);
  assertNodeOperational(node, 'rebuild workspace');
  await requireWorkspaceRestartGitHubAccess(c.env, db, workspace, userId, 'workspace-rebuild');

  // Rebuild also recreates runtime state, so it must obey the same point-of-no-
  // return fence as restart. A claimed delete cannot be cancelled or crossed.
  const doId = c.env.NODE_LIFECYCLE.idFromName(nodeId);
  const stub = c.env.NODE_LIFECYCLE.get(doId);
  const cancelled = await (
    stub as unknown as import('../../durable-objects/node-lifecycle').NodeLifecycle
  ).cancelWorkspaceDeletion(workspace.id);
  if (!cancelled) {
    throw errors.conflict('Workspace deletion has already started; rebuild is fenced');
  }

  // Clear previous error state and boot logs before starting new provisioning
  const rebuildTransition = await db
    .update(schema.workspaces)
    .set({
      status: 'creating',
      errorMessage: null,
      updatedAt: new Date().toISOString(),
      evictionGeneration,
      evictionFinalizedAt: null,
      stopRuntimeConfirmedAt: null,
    })
    .where(
      and(
        eq(schema.workspaces.id, workspace.id),
        eq(schema.workspaces.userId, userId),
        eq(schema.workspaces.nodeId, nodeId),
        eq(schema.workspaces.status, workspace.status),
        sql`${schema.workspaces.evictionGeneration} IS ${workspace.evictionGeneration}`,
        sql`${schema.workspaces.projectId} IS ${workspace.projectId}`,
        sql`${schema.workspaces.chatSessionId} IS ${workspace.chatSessionId}`,
        sql`${schema.workspaces.runtimeDeletionConfirmedAt} IS NULL`
      )
    )
    .run();
  if ((rebuildTransition.meta.changes ?? 0) !== 1) {
    throw errors.conflict('Workspace changed while rebuild cancellation was being claimed');
  }
  await writeBootLogs(c.env.KV, workspace.id, [], c.env);

  c.executionCtx.waitUntil(
    (async () => {
      const innerDb = drizzle(c.env.DATABASE, { schema });
      try {
        await rebuildWorkspaceOnNode(nodeId, workspace.id, c.env, userId, {
          evictionGeneration,
          expectedEvictionGeneration: workspace.evictionGeneration ?? '',
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
                  AND eviction_generation = ?
                  AND runtime_deletion_confirmed_at IS NULL
                LIMIT 1`
            )
              .bind(
                workspace.id,
                userId,
                nodeId,
                workspace.projectId,
                workspace.chatSessionId,
                evictionGeneration
              )
              .first<{ id: string }>();
            if (!current) throw new WorkspaceRuntimeRecreationFenceError('rebuild');
          },
        });
      } catch (err) {
        await recordWorkspaceRuntimeRecreationFailure(
          c.env,
          innerDb,
          workspace,
          userId,
          nodeId,
          'rebuild',
          evictionGeneration,
          err
        );
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
