import { and, eq, inArray } from 'drizzle-orm';
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

const WORKSPACE_EVICTION_CALLBACK_ACTIVE_STATUS_VALUES = ['creating', 'running', 'recovery'];
const WORKSPACE_EVICTION_CALLBACK_ACTIVE_STATUSES = new Set(
  WORKSPACE_EVICTION_CALLBACK_ACTIVE_STATUS_VALUES
);

const WorkspaceEvictionCallbackSchema = v.object({
  nodeId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  workspaceId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  reason: v.picklist(['memory_pressure', 'oom_kill']),
  snapshotCaptured: v.boolean(),
  containerStopped: v.boolean(),
});

type WorkspaceEvictionBody = v.InferOutput<typeof WorkspaceEvictionCallbackSchema>;
type AppDb = ReturnType<typeof drizzle<typeof schema>>;

type WorkspaceEvictionResource = {
  workspaceId: string;
  projectId: string | null;
  status: string;
  nodeId: string | null;
  nodeStatus: string | null;
  chatSessionId: string | null;
};

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

function terminalResourceResponse(
  c: Context<{ Bindings: Env }>,
  logName: string,
  payload: Record<string, unknown>
) {
  log.info(logName, { ...payload, action: 'terminal_gone' });
  return c.json(
    {
      error: 'GONE',
      message: 'Workspace eviction callback resource is gone',
    },
    410
  );
}

async function loadWorkspaceEvictionResource(
  db: AppDb,
  workspaceId: string
): Promise<WorkspaceEvictionResource | null> {
  return (
    (await db
      .select({
        workspaceId: schema.workspaces.id,
        projectId: schema.workspaces.projectId,
        status: schema.workspaces.status,
        nodeId: schema.workspaces.nodeId,
        nodeStatus: schema.nodes.status,
        chatSessionId: schema.workspaces.chatSessionId,
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
    if (!workspace) {
      if (
        (payload.scope === 'workspace' || payload.scope === undefined) &&
        payload.workspace !== workspaceId
      ) {
        throw errors.forbidden('Callback token not authorized for this workspace');
      }
      if (payload.scope === 'node' && payload.workspace !== body.nodeId) {
        throw errors.forbidden('Callback token not authorized for this node');
      }
      return terminalResourceResponse(c, 'workspace_eviction.terminal_workspace', {
        projectId,
        workspaceId,
        status: 'missing',
      });
    }

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

    if (
      !workspace.nodeId ||
      !workspace.nodeStatus ||
      nodeStatusTerminatesCallbacks(workspace.nodeStatus)
    ) {
      return terminalResourceResponse(c, 'workspace_eviction.terminal_node', {
        projectId,
        workspaceId,
        nodeId: workspace.nodeId ?? body.nodeId,
        status: workspace.nodeStatus ?? 'missing',
      });
    }

    if (!WORKSPACE_EVICTION_CALLBACK_ACTIVE_STATUSES.has(workspace.status)) {
      return terminalResourceResponse(c, 'workspace_eviction.terminal_workspace', {
        projectId,
        workspaceId,
        status: workspace.status,
      });
    }

    const now = new Date().toISOString();
    const transition = await db
      .update(schema.workspaces)
      .set({
        status: 'evicted',
        errorMessage: workspaceEvictionErrorMessage(body.reason),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.workspaces.id, workspaceId),
          eq(schema.workspaces.projectId, projectId),
          eq(schema.workspaces.nodeId, body.nodeId),
          inArray(schema.workspaces.status, WORKSPACE_EVICTION_CALLBACK_ACTIVE_STATUS_VALUES)
        )
      )
      .run();

    if ((transition.meta.changes ?? 0) === 0) {
      const latest = await loadWorkspaceEvictionResource(db, workspaceId);
      if (!latest) {
        return terminalResourceResponse(c, 'workspace_eviction.terminal_workspace', {
          projectId,
          workspaceId,
          status: 'missing',
        });
      }
      if (latest.projectId !== projectId) {
        throw errors.forbidden('Workspace is not linked to this project');
      }
      if (latest.nodeId !== body.nodeId) {
        throw errors.forbidden('Node identity verification failed');
      }
      if (!latest.nodeId || !latest.nodeStatus || nodeStatusTerminatesCallbacks(latest.nodeStatus)) {
        return terminalResourceResponse(c, 'workspace_eviction.terminal_node', {
          projectId,
          workspaceId,
          nodeId: latest.nodeId ?? body.nodeId,
          status: latest.nodeStatus ?? 'missing',
        });
      }
      if (!WORKSPACE_EVICTION_CALLBACK_ACTIVE_STATUSES.has(latest.status)) {
        return terminalResourceResponse(c, 'workspace_eviction.terminal_workspace', {
          projectId,
          workspaceId,
          status: latest.status,
        });
      }
      throw errors.conflict('Workspace eviction transition was not applied');
    }

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
