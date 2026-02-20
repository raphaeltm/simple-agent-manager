import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, count, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { ulid } from '../lib/ulid';
import type { Env } from '../index';
import { getAuth, getUserId, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import * as schema from '../db/schema';
import type {
  AgentSession,
  BootLogEntry,
  BootstrapTokenData,
  CreateAgentSessionRequest,
  CreateWorkspaceRequest,
  HeartbeatRequest,
  HeartbeatResponse,
  UpdateWorkspaceRequest,
  WorkspaceResponse,
} from '@simple-agent-manager/shared';
import { getWorkspaceUrl } from '../services/dns';
import { getRuntimeLimits } from '../services/limits';
import { resolveUniqueWorkspaceDisplayName } from '../services/workspace-names';
import { createNodeRecord, provisionNode } from '../services/nodes';
import {
  createAgentSessionOnNode,
  createWorkspaceOnNode,
  deleteWorkspaceOnNode,
  rebuildWorkspaceOnNode,
  restartWorkspaceOnNode,
  stopAgentSessionOnNode,
  stopWorkspaceOnNode,
  waitForNodeAgentReady,
} from '../services/node-agent';
import { signCallbackToken, verifyCallbackToken } from '../services/jwt';
import { recordNodeRoutingMetric } from '../services/telemetry';
import { getDecryptedAgentKey } from './credentials';
import { getInstallationToken } from '../services/github-app';
import { appendBootLog, getBootLogs } from '../services/boot-log';

const workspacesRoutes = new Hono<{ Bindings: Env }>();
const ACTIVE_WORKSPACE_STATUSES = new Set(['running', 'recovery'] as const);

workspacesRoutes.use('/*', async (c, next) => {
  const path = c.req.path;
  if (
    path.endsWith('/ready') ||
    path.endsWith('/heartbeat') ||
    path.endsWith('/agent-key') ||
    path.endsWith('/agent-settings') ||
    path.endsWith('/runtime') ||
    path.endsWith('/git-token') ||
    path.endsWith('/boot-log') ||
    path.endsWith('/provisioning-failed')
  ) {
    return next();
  }

  return requireAuth()(c, next);
});

function toWorkspaceResponse(ws: schema.Workspace, baseDomain: string): WorkspaceResponse {
  return {
    id: ws.id,
    nodeId: ws.nodeId ?? undefined,
    displayName: ws.displayName ?? ws.name,
    name: ws.name,
    repository: ws.repository,
    branch: ws.branch,
    status: ws.status as WorkspaceResponse['status'],
    vmSize: ws.vmSize as WorkspaceResponse['vmSize'],
    vmLocation: ws.vmLocation as WorkspaceResponse['vmLocation'],
    vmIp: ws.vmIp,
    lastActivityAt: ws.lastActivityAt,
    errorMessage: ws.errorMessage,
    shutdownDeadline: ws.shutdownDeadline,
    idleTimeoutSeconds: ws.idleTimeoutSeconds,
    createdAt: ws.createdAt,
    updatedAt: ws.updatedAt,
    url: getWorkspaceUrl(ws.id, baseDomain),
  };
}

function toAgentSessionResponse(session: schema.AgentSession): AgentSession {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    status: session.status as AgentSession['status'],
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    stoppedAt: session.stoppedAt,
    errorMessage: session.errorMessage,
    label: session.label,
    worktreePath: session.worktreePath,
  };
}

function getIdleTimeoutSeconds(env: Env): number {
  const value = env.IDLE_TIMEOUT_SECONDS;
  const parsed = value ? Number.parseInt(value, 10) : 30 * 60;
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 30 * 60;
  }
  return parsed;
}

function isActiveWorkspaceStatus(status: string): boolean {
  return ACTIVE_WORKSPACE_STATUSES.has(status as 'running' | 'recovery');
}

function normalizeWorkspaceReadyStatus(status: unknown): 'running' | 'recovery' {
  if (typeof status !== 'string') return 'running';
  const normalized = status.trim().toLowerCase();
  if (!normalized || normalized === 'running') return 'running';
  if (normalized === 'recovery') return 'recovery';
  throw errors.badRequest('status must be "running" or "recovery"');
}

async function getOwnedWorkspace(
  db: ReturnType<typeof drizzle<typeof schema>>,
  workspaceId: string,
  userId: string
): Promise<schema.Workspace> {
  const rows = await db
    .select()
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.userId, userId)))
    .limit(1);

  const workspace = rows[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  return workspace;
}

async function getOwnedNode(
  db: ReturnType<typeof drizzle<typeof schema>>,
  nodeId: string,
  userId: string
): Promise<schema.Node> {
  const rows = await db
    .select()
    .from(schema.nodes)
    .where(and(eq(schema.nodes.id, nodeId), eq(schema.nodes.userId, userId)))
    .limit(1);

  const node = rows[0];
  if (!node) {
    throw errors.notFound('Node');
  }

  return node;
}

function assertNodeOperational(node: schema.Node, action: string): void {
  if (node.status !== 'running') {
    throw errors.badRequest(`Cannot ${action}: node is ${node.status}`);
  }
  if (node.healthStatus === 'unhealthy') {
    throw errors.badRequest(`Cannot ${action}: node is unhealthy`);
  }
}

async function verifyWorkspaceCallbackAuth(
  c: Context<{ Bindings: Env }>,
  workspaceId: string
): Promise<void> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw errors.unauthorized('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7);
  const payload = await verifyCallbackToken(token, c.env);
  if (payload.workspace === workspaceId) {
    return;
  }

  const db = drizzle(c.env.DATABASE, { schema });
  const rows = await db
    .select({ nodeId: schema.workspaces.nodeId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = rows[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  if (workspace.nodeId && payload.workspace === workspace.nodeId) {
    return;
  }

  throw errors.forbidden('Token workspace mismatch');
}

async function scheduleWorkspaceCreateOnNode(
  env: Env,
  workspaceId: string,
  nodeId: string,
  userId: string,
  repository: string,
  branch: string,
  gitUserName?: string | null,
  gitUserEmail?: string | null
): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  const now = new Date().toISOString();

  await db
    .update(schema.workspaces)
    .set({ status: 'creating', errorMessage: null, updatedAt: now })
    .where(eq(schema.workspaces.id, workspaceId));

  try {
    const callbackToken = await signCallbackToken(workspaceId, env);
    await createWorkspaceOnNode(nodeId, env, userId, {
      workspaceId,
      repository,
      branch,
      callbackToken,
      gitUserName,
      gitUserEmail,
    });
  } catch (err) {
    await db
      .update(schema.workspaces)
      .set({
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Failed to create workspace on node',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workspaces.id, workspaceId));
  }
}

workspacesRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const status = c.req.query('status');
  const nodeId = c.req.query('nodeId');
  const db = drizzle(c.env.DATABASE, { schema });

  // Build WHERE conditions in SQL instead of filtering in memory (P1 fix).
  const conditions = [eq(schema.workspaces.userId, userId)];
  if (status) {
    conditions.push(eq(schema.workspaces.status, status));
  }
  if (nodeId) {
    conditions.push(eq(schema.workspaces.nodeId, nodeId));
  }

  const rows = await db
    .select()
    .from(schema.workspaces)
    .where(and(...conditions))
    .orderBy(desc(schema.workspaces.createdAt));

  return c.json(rows.map((workspace) => toWorkspaceResponse(workspace, c.env.BASE_DOMAIN)));
});

workspacesRoutes.get('/:id', async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  const response = toWorkspaceResponse(workspace, c.env.BASE_DOMAIN);

  if (workspace.status === 'creating') {
    response.bootLogs = await getBootLogs(c.env.KV, workspace.id);
  }

  return c.json(response);
});

workspacesRoutes.patch('/:id', async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  const body = await c.req.json<UpdateWorkspaceRequest>();

  if (!body.displayName?.trim()) {
    throw errors.badRequest('displayName is required');
  }

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  const nodeScopeId = workspace.nodeId ?? workspace.id;
  const uniqueName = await resolveUniqueWorkspaceDisplayName(
    db,
    nodeScopeId,
    body.displayName,
    workspace.id
  );

  await db
    .update(schema.workspaces)
    .set({
      nodeId: nodeScopeId,
      displayName: uniqueName.displayName,
      normalizedDisplayName: uniqueName.normalizedDisplayName,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.workspaces.id, workspace.id));

  const updated = await getOwnedWorkspace(db, workspace.id, userId);
  return c.json(toWorkspaceResponse(updated, c.env.BASE_DOMAIN));
});

workspacesRoutes.post('/', async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const db = drizzle(c.env.DATABASE, { schema });
  const body = await c.req.json<CreateWorkspaceRequest>();
  const now = new Date().toISOString();
  const limits = getRuntimeLimits(c.env);
  const normalizedRepository = body.repository?.trim().toLowerCase() || null;

  if (!body.name?.trim() || !body.repository?.trim() || !body.installationId) {
    throw errors.badRequest('name, repository, and installationId are required');
  }

  // Use COUNT instead of fetching all IDs (P1 fix).
  const [userWorkspaceCount] = await db
    .select({ count: count() })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.userId, userId));
  if ((userWorkspaceCount?.count ?? 0) >= limits.maxWorkspacesPerUser) {
    throw errors.badRequest(`Maximum ${limits.maxWorkspacesPerUser} workspaces allowed`);
  }

  const installationRows = await db
    .select({ id: schema.githubInstallations.id })
    .from(schema.githubInstallations)
    .where(
      and(
        eq(schema.githubInstallations.id, body.installationId),
        eq(schema.githubInstallations.userId, userId)
      )
    )
    .limit(1);
  if (!installationRows[0]) {
    throw errors.badRequest('GitHub installation not found');
  }

  const vmSize = body.vmSize ?? 'medium';
  const vmLocation = body.vmLocation ?? 'nbg1';
  const branch = body.branch?.trim() || 'main';

  let nodeId = body.nodeId;
  let mustProvisionNode = false;
  // Use COUNT instead of fetching all node IDs (P1 fix).
  const [userNodeCount] = await db
    .select({ count: count() })
    .from(schema.nodes)
    .where(eq(schema.nodes.userId, userId));
  const userNodeCountVal = userNodeCount?.count ?? 0;

  if (nodeId) {
    const node = await getOwnedNode(db, nodeId, userId);
    if (node.status === 'stopped' || node.healthStatus === 'unhealthy') {
      throw errors.badRequest('Selected node is not ready for workspace creation');
    }
  } else {
    if (userNodeCountVal >= limits.maxNodesPerUser) {
      throw errors.badRequest(`Maximum ${limits.maxNodesPerUser} nodes allowed`);
    }

    const createdNode = await createNodeRecord(c.env, {
      userId,
      name: `${body.name.trim()} Node`,
      vmSize,
      vmLocation,
      heartbeatStaleAfterSeconds: limits.nodeHeartbeatStaleSeconds,
    });

    nodeId = createdNode.id;
    mustProvisionNode = true;
  }
  const targetNodeId = nodeId;
  if (!targetNodeId) {
    throw errors.internal('Failed to determine target node');
  }

  // Use COUNT instead of fetching all workspace IDs per node (P1 fix).
  const [nodeWorkspaceCount] = await db
    .select({ count: count() })
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.userId, userId), eq(schema.workspaces.nodeId, targetNodeId)));
  const nodeWorkspaceCountVal = nodeWorkspaceCount?.count ?? 0;

  if (nodeWorkspaceCountVal >= limits.maxWorkspacesPerNode) {
    throw errors.badRequest(`Maximum ${limits.maxWorkspacesPerNode} workspaces allowed per node`);
  }

  const uniqueName = await resolveUniqueWorkspaceDisplayName(db, targetNodeId, body.name);
  const idleTimeoutSeconds = body.idleTimeoutSeconds ?? getIdleTimeoutSeconds(c.env);
  if (idleTimeoutSeconds < 0 || idleTimeoutSeconds > 86400) {
    throw errors.badRequest('idleTimeoutSeconds must be between 0 and 86400');
  }

  const workspaceId = ulid();

  await db.insert(schema.workspaces).values({
    id: workspaceId,
    nodeId: targetNodeId,
    userId,
    installationId: body.installationId,
    name: body.name,
    displayName: uniqueName.displayName,
    normalizedDisplayName: uniqueName.normalizedDisplayName,
    repository: body.repository,
    branch,
    status: 'creating',
    vmSize,
    vmLocation,
    idleTimeoutSeconds,
    createdAt: now,
    updatedAt: now,
  });

  const nodeCountForUser = userNodeCountVal + (mustProvisionNode ? 1 : 0);
  const workspaceCountForUser = (userWorkspaceCount?.count ?? 0) + 1;
  const reusedExistingNode = !mustProvisionNode;
  const workspaceCountOnNodeBefore = nodeWorkspaceCountVal;

  recordNodeRoutingMetric(
    {
      metric: 'sc_002_workspace_creation_flow',
      nodeId: targetNodeId,
      workspaceId,
      userId,
      repository: normalizedRepository,
      reusedExistingNode,
      workspaceCountOnNodeBefore,
      nodeCountForUser,
      workspaceCountForUser,
    },
    c.env
  );

  recordNodeRoutingMetric(
    {
      metric: 'sc_006_node_efficiency',
      nodeId: targetNodeId,
      workspaceId,
      userId,
      repository: normalizedRepository,
      reusedExistingNode,
      nodeCountForUser,
      workspaceCountForUser,
    },
    c.env
  );

  c.executionCtx.waitUntil(
    (async () => {
      const innerDb = drizzle(c.env.DATABASE, { schema });
      if (mustProvisionNode) {
        await provisionNode(targetNodeId, c.env);

        const nodeRows = await innerDb
          .select({
            status: schema.nodes.status,
            errorMessage: schema.nodes.errorMessage,
          })
          .from(schema.nodes)
          .where(eq(schema.nodes.id, targetNodeId))
          .limit(1);

        const provisionedNode = nodeRows[0];
        if (!provisionedNode || provisionedNode.status !== 'running') {
          await innerDb
            .update(schema.workspaces)
            .set({
              status: 'error',
              errorMessage: provisionedNode?.errorMessage || 'Node provisioning failed',
              updatedAt: new Date().toISOString(),
            })
            .where(eq(schema.workspaces.id, workspaceId));
          return;
        }

        try {
          await waitForNodeAgentReady(targetNodeId, c.env);
        } catch (err) {
          await innerDb
            .update(schema.workspaces)
            .set({
              status: 'error',
              errorMessage:
                err instanceof Error ? err.message : 'Node agent not reachable after provisioning',
              updatedAt: new Date().toISOString(),
            })
            .where(eq(schema.workspaces.id, workspaceId));
          return;
        }
      }

      await scheduleWorkspaceCreateOnNode(
        c.env,
        workspaceId,
        targetNodeId,
        userId,
        body.repository,
        branch,
        auth.user.name,
        auth.user.email
      );
    })()
  );

  const created = await getOwnedWorkspace(db, workspaceId, userId);
  return c.json(toWorkspaceResponse(created, c.env.BASE_DOMAIN), 201);
});

workspacesRoutes.post('/:id/stop', async (c) => {
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
            shutdownDeadline: null,
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

  return c.json({ status: 'stopping' });
});

workspacesRoutes.post('/:id/restart', async (c) => {
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

  await db
    .update(schema.workspaces)
    .set({ status: 'creating', errorMessage: null, updatedAt: new Date().toISOString() })
    .where(eq(schema.workspaces.id, workspace.id));

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

  return c.json({ status: 'creating' });
});

workspacesRoutes.post('/:id/rebuild', async (c) => {
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

  await db
    .update(schema.workspaces)
    .set({ status: 'creating', errorMessage: null, updatedAt: new Date().toISOString() })
    .where(eq(schema.workspaces.id, workspace.id));

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

workspacesRoutes.delete('/:id', async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);

  if (workspace.nodeId) {
    const node = await getOwnedNode(db, workspace.nodeId, userId);
    if (node.status === 'running' && node.healthStatus !== 'unhealthy') {
      try {
        await deleteWorkspaceOnNode(workspace.nodeId, workspace.id, c.env, userId);
      } catch {
        // Best-effort delete on node agent; DB delete still proceeds.
      }
    }
  }

  await db.delete(schema.agentSessions).where(eq(schema.agentSessions.workspaceId, workspace.id));

  await db
    .delete(schema.workspaces)
    .where(and(eq(schema.workspaces.id, workspace.id), eq(schema.workspaces.userId, userId)));

  return c.json({ success: true });
});

workspacesRoutes.get('/:id/agent-sessions', async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!workspace.nodeId) {
    return c.json([] as AgentSession[]);
  }

  const sessions = await db
    .select()
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.workspaceId, workspace.id),
        eq(schema.agentSessions.userId, userId)
      )
    )
    .orderBy(desc(schema.agentSessions.createdAt));

  return c.json(sessions.map(toAgentSessionResponse));
});

workspacesRoutes.post('/:id/agent-sessions', async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  const body = await c.req.json<CreateAgentSessionRequest>();
  const limits = getRuntimeLimits(c.env);

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!workspace.nodeId) {
    throw errors.badRequest('Workspace is not attached to a node');
  }

  const node = await getOwnedNode(db, workspace.nodeId, userId);
  assertNodeOperational(node, 'create agent session');

  const existingRunning = await db
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.workspaceId, workspace.id),
        eq(schema.agentSessions.userId, userId),
        eq(schema.agentSessions.status, 'running')
      )
    );

  if (existingRunning.length >= limits.maxAgentSessionsPerWorkspace) {
    throw errors.badRequest(
      `Maximum ${limits.maxAgentSessionsPerWorkspace} agent sessions per workspace`
    );
  }

  const sessionId = ulid();
  const now = new Date().toISOString();

  await db.insert(schema.agentSessions).values({
    id: sessionId,
    workspaceId: workspace.id,
    userId,
    status: 'running',
    label: body.label?.trim() || null,
    worktreePath: body.worktreePath?.trim() || null,
    createdAt: now,
    updatedAt: now,
  });

  try {
    await createAgentSessionOnNode(
      workspace.nodeId,
      workspace.id,
      sessionId,
      body.label?.trim() || null,
      c.env,
      userId
    );
  } catch (err) {
    await db
      .update(schema.agentSessions)
      .set({
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Failed to create agent session',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.agentSessions.id, sessionId));

    throw errors.internal('Failed to create agent session on node');
  }

  const rows = await db
    .select()
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, sessionId))
    .limit(1);

  return c.json(toAgentSessionResponse(rows[0]!), 201);
});

workspacesRoutes.patch('/:id/agent-sessions/:sessionId', async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const sessionId = c.req.param('sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  const body = await c.req.json<{ label?: string }>();
  const label = body.label?.trim()?.slice(0, 50);
  if (!label) {
    throw errors.badRequest('Label is required and must be non-empty');
  }

  const rows = await db
    .select()
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.id, sessionId),
        eq(schema.agentSessions.workspaceId, workspace.id),
        eq(schema.agentSessions.userId, userId)
      )
    )
    .limit(1);

  const session = rows[0];
  if (!session) {
    throw errors.notFound('Agent session');
  }

  if (session.status !== 'running') {
    throw errors.badRequest('Cannot rename a session that is not running');
  }

  await db
    .update(schema.agentSessions)
    .set({
      label,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.agentSessions.id, session.id));

  return c.json(toAgentSessionResponse({ ...session, label, updatedAt: new Date().toISOString() }));
});

workspacesRoutes.post('/:id/agent-sessions/:sessionId/stop', async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const sessionId = c.req.param('sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!workspace.nodeId) {
    throw errors.badRequest('Workspace is not attached to a node');
  }

  const rows = await db
    .select()
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.id, sessionId),
        eq(schema.agentSessions.workspaceId, workspace.id),
        eq(schema.agentSessions.userId, userId)
      )
    )
    .limit(1);

  const session = rows[0];
  if (!session) {
    throw errors.notFound('Agent session');
  }

  if (session.status !== 'running') {
    // Still attempt VM stop for orphaned sessions whose process may be alive
    if (workspace.nodeId) {
      try {
        await stopAgentSessionOnNode(workspace.nodeId, workspace.id, session.id, c.env, userId);
      } catch {
        // Best effort
      }
    }
    return c.json({ status: session.status });
  }

  try {
    await stopAgentSessionOnNode(workspace.nodeId, workspace.id, session.id, c.env, userId);
  } catch {
    // Best effort remote stop; local state still transitions.
  }

  await db
    .update(schema.agentSessions)
    .set({
      status: 'stopped',
      stoppedAt: new Date().toISOString(),
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.agentSessions.id, session.id));

  return c.json({ status: 'stopped' });
});

workspacesRoutes.post('/:id/agent-sessions/:sessionId/resume', async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const sessionId = c.req.param('sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);

  const rows = await db
    .select()
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.id, sessionId),
        eq(schema.agentSessions.workspaceId, workspace.id),
        eq(schema.agentSessions.userId, userId)
      )
    )
    .limit(1);

  const session = rows[0];
  if (!session) {
    throw errors.notFound('Agent session');
  }

  // Already running -- idempotent
  if (session.status === 'running') {
    return c.json(toAgentSessionResponse(session));
  }

  const now = new Date().toISOString();
  await db
    .update(schema.agentSessions)
    .set({
      status: 'running',
      stoppedAt: null,
      errorMessage: null,
      updatedAt: now,
    })
    .where(eq(schema.agentSessions.id, session.id));

  return c.json(
    toAgentSessionResponse({
      ...session,
      status: 'running',
      stoppedAt: null,
      errorMessage: null,
      updatedAt: now,
    })
  );
});

workspacesRoutes.post('/:id/ready', async (c) => {
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

  return c.json({ success: true });
});

workspacesRoutes.post('/:id/provisioning-failed', async (c) => {
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

  if (workspace.status !== 'creating') {
    return c.json({ success: false, reason: 'workspace_not_creating' });
  }

  await db
    .update(schema.workspaces)
    .set({
      status: 'error',
      errorMessage,
      shutdownDeadline: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.workspaces.id, workspaceId));

  return c.json({ success: true });
});

workspacesRoutes.post('/:id/heartbeat', async (c) => {
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  await verifyWorkspaceCallbackAuth(c, workspaceId);

  const body = await c.req.json<HeartbeatRequest>();
  const now = new Date().toISOString();
  const idleTimeoutSeconds = getIdleTimeoutSeconds(c.env);

  await db
    .update(schema.workspaces)
    .set({
      lastActivityAt: body.lastActivityAt || now,
      shutdownDeadline: null,
      updatedAt: now,
    })
    .where(eq(schema.workspaces.id, workspaceId));

  const response: HeartbeatResponse = {
    action: 'continue',
    idleSeconds: Math.max(0, Math.floor(body.idleSeconds ?? 0)),
    maxIdleSeconds: idleTimeoutSeconds,
    shutdownDeadline: null,
  };

  return c.json(response);
});

workspacesRoutes.post('/:id/agent-key', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const body = await c.req.json<{ agentType: string }>();

  if (!body.agentType) {
    throw errors.badRequest('agentType is required');
  }

  const db = drizzle(c.env.DATABASE, { schema });

  const workspaceRows = await db
    .select({ userId: schema.workspaces.userId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = workspaceRows[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  const credentialData = await getDecryptedAgentKey(
    db,
    workspace.userId,
    body.agentType,
    c.env.ENCRYPTION_KEY
  );

  if (!credentialData) {
    throw errors.notFound('Agent credential');
  }

  return c.json({
    apiKey: credentialData.credential,
    credentialKind: credentialData.credentialKind,
  });
});

/**
 * POST /:id/agent-settings — VM agent callback to fetch user's agent settings.
 * Uses workspace callback auth (same as agent-key).
 */
workspacesRoutes.post('/:id/agent-settings', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const body = await c.req.json<{ agentType: string }>();

  if (!body.agentType) {
    throw errors.badRequest('agentType is required');
  }

  const db = drizzle(c.env.DATABASE, { schema });

  const workspaceRows = await db
    .select({ userId: schema.workspaces.userId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = workspaceRows[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  const settingsRows = await db
    .select()
    .from(schema.agentSettings)
    .where(
      and(
        eq(schema.agentSettings.userId, workspace.userId),
        eq(schema.agentSettings.agentType, body.agentType)
      )
    )
    .limit(1);

  const row = settingsRows[0];
  if (!row) {
    return c.json({
      model: null,
      permissionMode: null,
    });
  }

  return c.json({
    model: row.model,
    permissionMode: row.permissionMode,
  });
});
workspacesRoutes.get('/:id/runtime', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  const db = drizzle(c.env.DATABASE, { schema });

  const workspaceRows = await db
    .select({
      id: schema.workspaces.id,
      repository: schema.workspaces.repository,
      branch: schema.workspaces.branch,
      status: schema.workspaces.status,
      nodeId: schema.workspaces.nodeId,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = workspaceRows[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  return c.json({
    workspaceId: workspace.id,
    repository: workspace.repository,
    branch: workspace.branch,
    status: workspace.status,
    nodeId: workspace.nodeId,
  });
});

workspacesRoutes.post('/:id/git-token', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  const db = drizzle(c.env.DATABASE, { schema });

  const workspaceRows = await db
    .select({ installationId: schema.workspaces.installationId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = workspaceRows[0];
  if (!workspace || !workspace.installationId) {
    throw errors.notFound('Workspace');
  }

  const installations = await db
    .select({ installationId: schema.githubInstallations.installationId })
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.id, workspace.installationId))
    .limit(1);

  const installation = installations[0];
  if (!installation) {
    throw errors.notFound('GitHub installation');
  }

  const token = await getInstallationToken(installation.installationId, c.env);
  return c.json({ token: token.token, expiresAt: token.expiresAt });
});

workspacesRoutes.post('/:id/boot-log', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  const body = await c.req.json<BootLogEntry>();
  if (!body.step || !body.status || !body.message) {
    throw errors.badRequest('step, status, and message are required');
  }

  const entry: BootLogEntry = {
    step: body.step,
    status: body.status,
    message: body.message,
    detail: body.detail,
    timestamp: body.timestamp || new Date().toISOString(),
  };

  await appendBootLog(c.env.KV, workspaceId, entry, c.env);
  return c.json({ success: true });
});

// Legacy compatibility endpoint for node-side bootstrap exchange.
workspacesRoutes.post('/:id/bootstrap-token', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  const bootstrapToken = ulid();
  const now = new Date().toISOString();
  const data: BootstrapTokenData = {
    workspaceId,
    encryptedHetznerToken: '',
    hetznerTokenIv: '',
    callbackToken: '',
    encryptedGithubToken: null,
    githubTokenIv: null,
    gitUserName: null,
    gitUserEmail: null,
    createdAt: now,
  };

  await c.env.KV.put(`bootstrap:${bootstrapToken}`, JSON.stringify(data), {
    expirationTtl: 60,
  });

  return c.json({ token: bootstrapToken });
});

export { workspacesRoutes };
