import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import { log } from '../../lib/logger';
import { errors } from '../../middleware/error';
import { jsonValidator } from '../../schemas';
import { type CallbackTokenPayload, verifyCallbackToken } from '../../services/jwt';
import {
  callbackTokenMatchesNode,
  callbackTokenMatchesWorkspace,
  nodeStatusTerminatesCallbacks,
} from '../../services/node-callback-auth';
import * as projectDataService from '../../services/project-data';
import { finalizeWorkspaceEvictionOnNode } from '../../services/workspace-eviction-lifecycle';
import { recoverWorkspaceAfterEviction } from '../../services/workspace-eviction-recovery';

const WORKSPACE_EVICTION_CALLBACK_ACTIVE_STATUS_VALUES = [
  'creating',
  'running',
  'recovery',
  'stopping',
];
const WORKSPACE_EVICTION_CALLBACK_ACTIVE_STATUSES = new Set(
  WORKSPACE_EVICTION_CALLBACK_ACTIVE_STATUS_VALUES
);

const WorkspaceEvictionCallbackSchema = v.object({
  nodeId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  workspaceId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  reason: v.picklist(['memory_pressure', 'oom_kill']),
  snapshotCaptured: v.boolean(),
  containerStopped: v.boolean(),
  evictionGeneration: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1)))),
});

type WorkspaceEvictionBody = v.InferOutput<typeof WorkspaceEvictionCallbackSchema>;
type AppDb = ReturnType<typeof drizzle<typeof schema>>;

type WorkspaceEvictionResource = {
  workspaceId: string;
  userId: string;
  projectId: string | null;
  status: string;
  nodeId: string | null;
  nodeStatus: string | null;
  chatSessionId: string | null;
  updatedAt: string;
  evictionGeneration: string | null;
};

const RETRYABLE_EVICTION_RECOVERY_REASONS = new Set([
  'workspace_deletion_unconfirmed',
  'session_recovery_placement_placement',
  'session_recovery_placement_transient',
]);

/**
 * VM-agent workspace eviction callback — mounted BEFORE projectsRoutes in
 * index.ts so callback JWT bearer tokens are verified here instead of falling
 * through to browser session auth.
 *
 * Auth: Callback JWT via Bearer token, verified inline with
 * extractBearerToken() + verifyCallbackToken(). Accepts node-scoped steady-state
 * tokens and workspace-scoped bootstrap tokens, but always binds the token's own
 * identity to the D1 workspace/node row before mutation.
 *
 * See: .claude/rules/34-vm-agent-callback-auth.md
 */
const workspaceEvictionCallbackRoute = new Hono<{ Bindings: Env }>();

function terminalResourceResponse(logName: string, payload: Record<string, unknown>): never {
  log.info(logName, { ...payload, action: 'terminal_gone' });
  throw errors.gone('Workspace eviction callback resource is gone');
}

async function loadWorkspaceEvictionResource(
  db: AppDb,
  workspaceId: string
): Promise<WorkspaceEvictionResource | null> {
  return (
    (await db
      .select({
        workspaceId: schema.workspaces.id,
        userId: schema.workspaces.userId,
        projectId: schema.workspaces.projectId,
        status: schema.workspaces.status,
        nodeId: schema.workspaces.nodeId,
        nodeStatus: schema.nodes.status,
        chatSessionId: schema.workspaces.chatSessionId,
        updatedAt: schema.workspaces.updatedAt,
        evictionGeneration: schema.workspaces.evictionGeneration,
      })
      .from(schema.workspaces)
      .leftJoin(schema.nodes, eq(schema.nodes.id, schema.workspaces.nodeId))
      .where(eq(schema.workspaces.id, workspaceId))
      .get()) ?? null
  );
}

function tokenMatchesEvictionResource(
  payload: CallbackTokenPayload,
  workspace: WorkspaceEvictionResource,
  body: WorkspaceEvictionBody
): boolean {
  if (payload.scope === 'node') {
    return callbackTokenMatchesNode(payload, workspace.nodeId) && workspace.nodeId === body.nodeId;
  }
  if (payload.scope === 'workspace') {
    return callbackTokenMatchesWorkspace(payload, workspace.workspaceId);
  }
  return payload.workspace === workspace.workspaceId;
}

function workspaceEvictionErrorMessage(reason: WorkspaceEvictionBody['reason']): string {
  return reason === 'oom_kill'
    ? 'Workspace evicted after container OOM'
    : 'Workspace evicted due to memory pressure';
}

function evictionRecoveryReasonIsRetryable(reason: string): boolean {
  return (
    RETRYABLE_EVICTION_RECOVERY_REASONS.has(reason) || reason.startsWith('recovery_start_failed:')
  );
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

function rejectMissingWorkspaceCallback(
  payload: CallbackTokenPayload,
  workspaceId: string,
  nodeId: string
): never {
  const expectedIdentity = payload.scope === 'node' ? nodeId : workspaceId;
  if (payload.workspace !== expectedIdentity) {
    throw errors.forbidden('Callback token not authorized for this resource');
  }
  throw errors.gone('Workspace eviction callback resource is gone');
}

function assertEvictionIdentity(
  payload: CallbackTokenPayload,
  workspace: WorkspaceEvictionResource,
  body: WorkspaceEvictionBody,
  projectId: string,
  workspaceId: string
): void {
  if (!tokenMatchesEvictionResource(payload, workspace, body)) {
    log.warn('workspace_eviction.callback_token_not_bound_to_resource', {
      projectId,
      workspaceId,
      nodeId: body.nodeId,
      scope: payload.scope,
      tokenIdentity: payload.workspace,
      workspaceNodeId: workspace.nodeId,
      action: 'rejected',
    });
    throw errors.forbidden('Callback token not authorized for this workspace eviction');
  }

  if (workspace.nodeId !== body.nodeId) {
    log.warn('workspace_eviction.node_mismatch', {
      projectId,
      workspaceId,
      expectedNodeId: workspace.nodeId,
      receivedNodeId: body.nodeId,
      action: 'rejected',
    });
    throw errors.forbidden('Node identity verification failed');
  }

  if (workspace.projectId !== projectId) {
    log.warn('workspace_eviction.project_mismatch', {
      projectId,
      workspaceId,
      actualProjectId: workspace.projectId,
      action: 'rejected',
    });
    throw errors.forbidden('Workspace is not linked to this project');
  }
  if (workspace.evictionGeneration !== (body.evictionGeneration ?? null)) {
    throw errors.gone('Workspace eviction belongs to an earlier runtime generation');
  }
}

async function evictionTerminalResponse(
  c: Context<{ Bindings: Env }>,
  workspace: WorkspaceEvictionResource,
  body: WorkspaceEvictionBody,
  projectId: string,
  workspaceId: string
): Promise<Response | null> {
  // A committed eviction may still be waiting on DO-side cleanup. Replay that
  // cleanup before telling the VM agent to stop retrying, even if the node has
  // already moved into a terminal lifecycle state.
  if (workspace.status === 'evicted') {
    await finalizeEvictionLifecycle(c.env, workspace);
    await recoverEvictedWorkspace(c.env, workspace, body, projectId);
    return c.body(null, 204);
  }

  if (
    !workspace.nodeId ||
    !workspace.nodeStatus ||
    nodeStatusTerminatesCallbacks(workspace.nodeStatus)
  ) {
    return terminalResourceResponse('workspace_eviction.terminal_node', {
      projectId,
      workspaceId,
      nodeId: workspace.nodeId ?? body.nodeId,
      status: workspace.nodeStatus ?? 'missing',
    });
  }

  if (!WORKSPACE_EVICTION_CALLBACK_ACTIVE_STATUSES.has(workspace.status)) {
    return terminalResourceResponse('workspace_eviction.terminal_workspace', {
      projectId,
      workspaceId,
      status: workspace.status,
    });
  }
  return null;
}

workspaceEvictionCallbackRoute.post(
  '/:id/workspaces/:workspaceId/eviction',
  jsonValidator(WorkspaceEvictionCallbackSchema),
  async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    const payload = await verifyCallbackToken(token, c.env);
    const projectId = c.req.param('id');
    const workspaceId = c.req.param('workspaceId');
    const body = c.req.valid('json');

    if (body.workspaceId !== workspaceId) {
      throw errors.badRequest('workspaceId body/path mismatch');
    }

    const db = drizzle(c.env.DATABASE, { schema });
    const workspace = await loadWorkspaceEvictionResource(db, workspaceId);
    if (!workspace) rejectMissingWorkspaceCallback(payload, workspaceId, body.nodeId);
    assertEvictionIdentity(payload, workspace, body, projectId, workspaceId);
    const terminal = await evictionTerminalResponse(c, workspace, body, projectId, workspaceId);
    if (terminal) return terminal;

    if (!body.snapshotCaptured) {
      throw errors.conflict('Workspace eviction requires a restorable snapshot');
    }

    if (!body.containerStopped) {
      throw errors.conflict('Workspace container must be stopped before eviction is recorded');
    }

    const now = new Date().toISOString();
    // Keep capacity release and billing/session closure in one D1 transaction.
    // The exact identity CAS also fences a node teardown or session reassignment
    // that races authentication. The stopped container and snapshot remain intact.
    const errorMessage = workspaceEvictionErrorMessage(body.reason);
    const claimedWorkspace = `SELECT id FROM workspaces
      WHERE id = ? AND user_id = ? AND project_id = ? AND node_id = ?
        AND chat_session_id IS ? AND status = 'evicted' AND updated_at = ?`;
    const claimBindings = [
      workspaceId,
      workspace.userId,
      projectId,
      body.nodeId,
      workspace.chatSessionId,
      now,
    ];
    const [transition] = await c.env.DATABASE.batch([
      c.env.DATABASE.prepare(
        `UPDATE workspaces SET status = 'evicted', error_message = ?, updated_at = ?, eviction_finalized_at = NULL,
           stop_runtime_confirmed_at = NULL
         WHERE id = ? AND user_id = ? AND project_id = ? AND node_id = ?
           AND chat_session_id IS ? AND status = ? AND eviction_generation IS ? AND runtime_deletion_confirmed_at IS NULL
           AND EXISTS (SELECT 1 FROM nodes WHERE nodes.id = workspaces.node_id AND nodes.status = ?)`
      ).bind(
        errorMessage,
        now,
        workspaceId,
        workspace.userId,
        projectId,
        body.nodeId,
        workspace.chatSessionId,
        workspace.status,
        workspace.evictionGeneration,
        workspace.nodeStatus
      ),
      c.env.DATABASE.prepare(
        `UPDATE agent_sessions SET status = 'stopped', stopped_at = COALESCE(stopped_at, ?),
           error_message = ?, updated_at = ?
         WHERE workspace_id IN (${claimedWorkspace}) AND user_id = ?
           AND status NOT IN ('completed', 'failed', 'stopped', 'error')`
      ).bind(now, errorMessage, now, ...claimBindings, workspace.userId),
      c.env.DATABASE.prepare(
        `UPDATE compute_usage SET ended_at = ?
         WHERE workspace_id IN (${claimedWorkspace}) AND ended_at IS NULL`
      ).bind(now, ...claimBindings),
      c.env.DATABASE.prepare(
        `UPDATE session_snapshots SET sleep_status = NULL, sleep_after = NULL,
           sleep_claim_id = NULL, sleep_claimed_at = NULL, sleep_stopping_since = NULL,
           sleep_error = NULL, updated_at = ?
         WHERE workspace_id IN (${claimedWorkspace}) AND sleeping_at IS NULL
           AND sleep_status IN ('scheduled', 'preparing', 'failed')`
      ).bind(now, ...claimBindings),
    ]);

    if ((transition?.meta.changes ?? 0) === 0) {
      const latest = await loadWorkspaceEvictionResource(db, workspaceId);
      if (!latest) rejectMissingWorkspaceCallback(payload, workspaceId, body.nodeId);
      assertEvictionIdentity(payload, latest, body, projectId, workspaceId);
      const latestTerminal = await evictionTerminalResponse(
        c,
        latest,
        body,
        projectId,
        workspaceId
      );
      if (latestTerminal) return latestTerminal;
      throw errors.conflict('Workspace eviction transition was not applied');
    }

    await finalizeEvictionLifecycle(c.env, workspace);
    await recoverEvictedWorkspace(
      c.env,
      { ...workspace, status: 'evicted', updatedAt: now },
      body,
      projectId
    );

    c.executionCtx.waitUntil(
      projectDataService
        .recordActivityEvent(
          c.env,
          projectId,
          'workspace.evicted',
          'vm-agent',
          body.nodeId,
          workspaceId,
          workspace.chatSessionId,
          null,
          {
            reason: body.reason,
            snapshotCaptured: body.snapshotCaptured,
            containerStopped: body.containerStopped,
            nodeId: body.nodeId,
            evictedAt: now,
          }
        )
        .catch((err) => {
          log.warn('workspace_eviction.activity_record_failed', {
            projectId,
            workspaceId,
            nodeId: body.nodeId,
            error: err instanceof Error ? err.message : String(err),
          });
        })
    );

    log.info('workspace_eviction.recorded', {
      projectId,
      workspaceId,
      nodeId: body.nodeId,
      reason: body.reason,
      snapshotCaptured: body.snapshotCaptured,
      containerStopped: body.containerStopped,
    });

    return c.body(null, 204);
  }
);

export { workspaceEvictionCallbackRoute };
