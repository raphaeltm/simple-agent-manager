import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import { log } from '../../lib/logger';
import { errors } from '../../middleware/error';
import { AcpSessionHeartbeatSchema, jsonValidator } from '../../schemas';
import { type CallbackTokenPayload, verifyCallbackToken } from '../../services/jwt';
import {
  callbackTokenMatchesNode,
  nodeStatusTerminatesCallbacks,
} from '../../services/node-callback-auth';
import * as projectDataService from '../../services/project-data';

/**
 * Node-level ACP heartbeat route — mounted BEFORE projectsRoutes in index.ts
 * to avoid the blanket requireAuth() middleware that validates browser session
 * cookies (not callback JWTs).
 *
 * Auth: Callback JWT via Bearer token, verified inline with verifyCallbackToken().
 * Accepts both workspace-scoped and node-scoped tokens because the VM agent's
 * token may be refreshed from workspace-scoped to node-scoped during the node
 * heartbeat response cycle.
 *
 * See: .claude/rules/06-api-patterns.md (Hono middleware scoping)
 * See: docs/notes/2026-03-25-deployment-identity-token-middleware-leak-postmortem.md
 */
const nodeAcpHeartbeatRoute = new Hono<{ Bindings: Env }>();
const ACP_HEARTBEAT_WORKSPACE_ACTIVE_STATUS_VALUES = ['creating', 'running', 'recovery'] as const;
const ACP_HEARTBEAT_WORKSPACE_ACTIVE_STATUSES = new Set<string>(
  ACP_HEARTBEAT_WORKSPACE_ACTIVE_STATUS_VALUES
);

type AppDb = ReturnType<typeof drizzle<typeof schema>>;

type TerminalCallbackResource =
  | { kind: 'node'; status: string }
  | { kind: 'workspace'; workspaceId: string; status: string };

function rejectInvalidScope(scope: CallbackTokenPayload['scope']): never {
  log.warn('acp_heartbeat.invalid_token_scope', {
    scope,
    action: 'rejected',
  });
  throw errors.forbidden('Invalid token scope for ACP heartbeat');
}

async function loadNodeStatus(db: AppDb, nodeId: string): Promise<string | null> {
  const nodeRow = await db
    .select({ status: schema.nodes.status })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, nodeId))
    .get();
  return nodeRow?.status ?? null;
}

function inactiveWorkspaceResource(
  workspaceId: string,
  status: string
): TerminalCallbackResource | null {
  return ACP_HEARTBEAT_WORKSPACE_ACTIVE_STATUSES.has(status)
    ? null
    : { kind: 'workspace', workspaceId, status };
}

async function authorizeNodeScopedHeartbeat(
  db: AppDb,
  payload: CallbackTokenPayload,
  projectId: string,
  requestedNodeId: string
): Promise<TerminalCallbackResource | null> {
  const nodeStatus = await loadNodeStatus(db, requestedNodeId);
  if (!nodeStatus || nodeStatusTerminatesCallbacks(nodeStatus)) {
    return { kind: 'node', status: nodeStatus ?? 'missing' };
  }

  const projectWorkspaceFilter = and(
    eq(schema.workspaces.nodeId, requestedNodeId),
    eq(schema.workspaces.projectId, projectId)
  );
  const activeProjectWorkspace = await db
    .select({
      id: schema.workspaces.id,
      status: schema.workspaces.status,
    })
    .from(schema.workspaces)
    .where(
      and(
        projectWorkspaceFilter,
        inArray(schema.workspaces.status, ACP_HEARTBEAT_WORKSPACE_ACTIVE_STATUS_VALUES)
      )
    )
    .limit(1)
    .get();

  if (activeProjectWorkspace) {
    return null;
  }

  const projectWorkspace = await db
    .select({
      id: schema.workspaces.id,
      status: schema.workspaces.status,
    })
    .from(schema.workspaces)
    .where(projectWorkspaceFilter)
    .limit(1)
    .get();

  if (!projectWorkspace) {
    log.warn('acp_heartbeat.node_not_bound_to_project', {
      projectId,
      requestedNodeId,
      scope: payload.scope,
      tokenIdentity: payload.workspace,
      action: 'rejected',
    });
    throw errors.forbidden('Callback token not authorized for this project');
  }

  return inactiveWorkspaceResource(projectWorkspace.id, projectWorkspace.status);
}

async function authorizeWorkspaceScopedHeartbeat(
  db: AppDb,
  payload: CallbackTokenPayload,
  projectId: string,
  requestedNodeId: string
): Promise<TerminalCallbackResource | null> {
  const workspaceRow = await db
    .select({
      nodeId: schema.workspaces.nodeId,
      projectId: schema.workspaces.projectId,
      status: schema.workspaces.status,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, payload.workspace))
    .get();

  if (!workspaceRow) {
    return { kind: 'workspace', workspaceId: payload.workspace, status: 'missing' };
  }

  const authorized = workspaceRow.nodeId === requestedNodeId && workspaceRow.projectId === projectId;
  if (!authorized) {
    log.warn('acp_heartbeat.callback_token_not_bound_to_node', {
      projectId,
      requestedNodeId,
      scope: payload.scope,
      tokenIdentity: payload.workspace,
      action: 'rejected',
    });
    throw errors.forbidden('Callback token not authorized for this node');
  }

  return inactiveWorkspaceResource(payload.workspace, workspaceRow.status);
}

async function authorizeAcpHeartbeat(
  db: AppDb,
  payload: CallbackTokenPayload,
  projectId: string,
  requestedNodeId: string
): Promise<TerminalCallbackResource | null> {
  if (payload.scope === 'node') {
    if (!callbackTokenMatchesNode(payload, requestedNodeId)) {
      log.warn('acp_heartbeat.callback_token_not_bound_to_node', {
        projectId,
        requestedNodeId,
        scope: payload.scope,
        tokenIdentity: payload.workspace,
        action: 'rejected',
      });
      throw errors.forbidden('Callback token not authorized for this node');
    }

    return authorizeNodeScopedHeartbeat(db, payload, projectId, requestedNodeId);
  }

  if (payload.scope === 'workspace' || payload.scope === undefined) {
    return authorizeWorkspaceScopedHeartbeat(db, payload, projectId, requestedNodeId);
  }

  rejectInvalidScope(payload.scope);
}

function logTerminalResource(
  projectId: string,
  requestedNodeId: string,
  resource: TerminalCallbackResource
): void {
  if (resource.kind === 'node') {
    log.info('acp_heartbeat.terminal_node', {
      projectId,
      nodeId: requestedNodeId,
      status: resource.status,
      action: 'terminal_gone',
    });
    return;
  }
  log.info('acp_heartbeat.terminal_workspace', {
    projectId,
    workspaceId: resource.workspaceId,
    requestedNodeId,
    status: resource.status,
    action: 'terminal_gone',
  });
}

function terminalResourcePayload(resource: TerminalCallbackResource): {
  error: 'GONE';
  message: string;
} {
  const noun = resource.kind === 'node' ? 'Node' : 'Workspace';
  return {
    error: 'GONE',
    message: `${noun} is ${resource.status}; ACP heartbeat resource is gone`,
  };
}

function terminalResourceResponse(
  c: Context<{ Bindings: Env }>,
  projectId: string,
  requestedNodeId: string,
  resource: TerminalCallbackResource
) {
  logTerminalResource(projectId, requestedNodeId, resource);
  return c.json(terminalResourcePayload(resource), 410);
}

nodeAcpHeartbeatRoute.post(
  '/:id/node-acp-heartbeat',
  jsonValidator(AcpSessionHeartbeatSchema),
  async (c) => {
    // Verify callback JWT (not BetterAuth session cookie)
    const token = extractBearerToken(c.req.header('Authorization'));
    const payload = await verifyCallbackToken(token, c.env);

    const projectId = c.req.param('id');
    const body = c.req.valid('json');
    const db = drizzle(c.env.DATABASE, { schema });

    // Authoritative auth: bind the token's OWN identity to the node it claims to heartbeat, instead
    // of trusting the client-supplied body.nodeId. A node-scoped token (the steady state, after the
    // first heartbeat refresh) must equal body.nodeId — a pure check, no lookup. A workspace-scoped
    // token (the transient initial token) is accepted only if that workspace is actually assigned to
    // body.nodeId (single indexed PK lookup, hit only during the brief pre-refresh window). Without
    // this, a holder of any valid callback token could keep ANOTHER tenant's sessions alive by
    // supplying a guessed nodeId. See .claude/rules/28 and security-critique #1.
    const authTerminalResource = await authorizeAcpHeartbeat(db, payload, projectId, body.nodeId);
    if (authTerminalResource) {
      return terminalResourceResponse(c, projectId, body.nodeId, authTerminalResource);
    }

    const activeNodeStatus = await loadNodeStatus(db, body.nodeId);
    if (!activeNodeStatus || nodeStatusTerminatesCallbacks(activeNodeStatus)) {
      return terminalResourceResponse(c, projectId, body.nodeId, {
        kind: 'node',
        status: activeNodeStatus ?? 'missing',
      });
    }

    let updated: number;
    try {
      updated = await projectDataService.updateNodeHeartbeats(c.env, projectId, body.nodeId);
    } catch (error) {
      log.error('acp_heartbeat.update_failed', {
        projectId,
        nodeId: body.nodeId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    log.debug('acp_heartbeat.node_level', {
      projectId,
      nodeId: body.nodeId,
      updatedSessions: updated,
    });
    return c.body(null, 204);
  }
);

export { nodeAcpHeartbeatRoute };
