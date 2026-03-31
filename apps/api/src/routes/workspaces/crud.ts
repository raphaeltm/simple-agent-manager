import { Hono } from 'hono';
import { and, count, desc, eq, inArray, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { ulid } from '../../lib/ulid';
import type { Env } from '../../index';
import { getAuth, getUserId, requireAuth, requireApproved } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import * as schema from '../../db/schema';
import { DEFAULT_VM_SIZE, DEFAULT_VM_LOCATION } from '@simple-agent-manager/shared';
import { jsonValidator, UpdateWorkspaceSchema, CreateWorkspaceSchema } from '../../schemas';
import { getRuntimeLimits } from '../../services/limits';
import { resolveUniqueWorkspaceDisplayName } from '../../services/workspace-names';
import { createNodeRecord, provisionNode } from '../../services/nodes';
import {
  deleteWorkspaceOnNode,
  waitForNodeAgentReady,
} from '../../services/node-agent';
import { recordNodeRoutingMetric } from '../../services/telemetry';
import { requireOwnedProject } from '../../middleware/project-auth';
import * as projectDataService from '../../services/project-data';
import { log } from '../../lib/logger';
import { toWorkspaceResponse } from '../../lib/mappers';
import { getOwnedWorkspace, getOwnedNode, scheduleWorkspaceCreateOnNode } from './_helpers';

const crudRoutes = new Hono<{ Bindings: Env }>();

// Auth applied per-route (NOT via use('/*', ...)) to prevent middleware leakage
// to other subrouters (lifecycle, runtime) mounted at the same base path.
// See docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md

crudRoutes.get('/', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const status = c.req.query('status');
  const nodeId = c.req.query('nodeId');
  const projectId = c.req.query('projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  // Build WHERE conditions in SQL instead of filtering in memory (P1 fix).
  const conditions = [eq(schema.workspaces.userId, userId)];
  if (status) {
    conditions.push(eq(schema.workspaces.status, status));
  } else {
    // Exclude deleted workspaces by default unless explicitly requested
    conditions.push(ne(schema.workspaces.status, 'deleted'));
  }
  if (nodeId) {
    conditions.push(eq(schema.workspaces.nodeId, nodeId));
  }
  if (projectId) {
    conditions.push(eq(schema.workspaces.projectId, projectId));
  }

  const rows = await db
    .select()
    .from(schema.workspaces)
    .where(and(...conditions))
    .orderBy(desc(schema.workspaces.createdAt));

  return c.json(rows.map((workspace) => toWorkspaceResponse(workspace, c.env.BASE_DOMAIN)));
});

crudRoutes.get('/:id', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  const response = toWorkspaceResponse(workspace, c.env.BASE_DOMAIN);

  if (workspace.status === 'creating') {
    const { getBootLogs } = await import('../../services/boot-log');
    response.bootLogs = await getBootLogs(c.env.KV, workspace.id);
  }

  return c.json(response);
});

crudRoutes.patch('/:id', requireAuth(), requireApproved(), jsonValidator(UpdateWorkspaceSchema), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  const body = c.req.valid('json');

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

crudRoutes.post('/', requireAuth(), requireApproved(), jsonValidator(CreateWorkspaceSchema), async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const db = drizzle(c.env.DATABASE, { schema });
  const body = c.req.valid('json');
  const now = new Date().toISOString();
  const limits = getRuntimeLimits(c.env);
  const projectId = body.projectId?.trim();
  const workspaceName = body.name?.trim();

  if (!workspaceName) {
    throw errors.badRequest('name is required');
  }

  if (!projectId) {
    throw errors.badRequest('projectId is required');
  }

  const linkedProject = await requireOwnedProject(db, projectId, userId);
  const resolvedInstallationId = linkedProject.installationId;
  const resolvedRepository = linkedProject.repository;
  const resolvedBranch = body.branch?.trim() || linkedProject.defaultBranch;

  if (!resolvedRepository || !resolvedInstallationId) {
    throw errors.badRequest('repository and installationId are required');
  }
  const normalizedRepository = resolvedRepository.toLowerCase();

  const installationRows = await db
    .select({ id: schema.githubInstallations.id })
    .from(schema.githubInstallations)
    .where(
      and(
        eq(schema.githubInstallations.id, resolvedInstallationId),
        eq(schema.githubInstallations.userId, userId)
      )
    )
    .limit(1);
  if (!installationRows[0]) {
    throw errors.badRequest('GitHub installation not found');
  }

  const vmSize = body.vmSize ?? DEFAULT_VM_SIZE;
  const vmLocation = body.vmLocation ?? DEFAULT_VM_LOCATION;

  // Validate branch name — reject shell metacharacters to prevent command injection.
  // Git branch names allow: alphanumeric, hyphens, underscores, slashes, dots.
  // See INJ-VULN-02 in Shannon security assessment.
  const SAFE_BRANCH_PATTERN = /^[a-zA-Z0-9._\-/]+$/;
  if (!SAFE_BRANCH_PATTERN.test(resolvedBranch)) {
    throw errors.badRequest(
      'branch contains invalid characters. Only alphanumeric, hyphens, underscores, slashes, and dots are allowed.'
    );
  }
  const branch = resolvedBranch;

  let nodeId = body.nodeId;
  let mustProvisionNode = false;
  // Use COUNT instead of fetching all node IDs (P1 fix).
  // Exclude deleted/stopped nodes — only active ones count toward the limit.
  const [userNodeCount] = await db
    .select({ count: count() })
    .from(schema.nodes)
    .where(and(
      eq(schema.nodes.userId, userId),
      inArray(schema.nodes.status, ['running', 'creating', 'recovery'])
    ));
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
      name: `${workspaceName} Node`,
      vmSize,
      vmLocation,
      cloudProvider: body.provider,
      heartbeatStaleAfterSeconds: limits.nodeHeartbeatStaleSeconds,
    });

    nodeId = createdNode.id;
    mustProvisionNode = true;
  }
  const targetNodeId = nodeId;
  if (!targetNodeId) {
    throw errors.internal('Failed to determine target node');
  }

  // Count active workspaces on this node (for telemetry — no hard count limit,
  // resource thresholds handle capacity in the task runner path).
  const [nodeWorkspaceCount] = await db
    .select({ count: count() })
    .from(schema.workspaces)
    .where(and(
      eq(schema.workspaces.userId, userId),
      eq(schema.workspaces.nodeId, targetNodeId),
      inArray(schema.workspaces.status, ['running', 'creating', 'recovery'])
    ));
  const nodeWorkspaceCountVal = nodeWorkspaceCount?.count ?? 0;

  const uniqueName = await resolveUniqueWorkspaceDisplayName(db, targetNodeId, workspaceName);

  const workspaceId = ulid();

  await db.insert(schema.workspaces).values({
    id: workspaceId,
    nodeId: targetNodeId,
    projectId: linkedProject.id,
    userId,
    installationId: resolvedInstallationId,
    name: workspaceName,
    displayName: uniqueName.displayName,
    normalizedDisplayName: uniqueName.normalizedDisplayName,
    repository: resolvedRepository,
    branch,
    status: 'creating',
    vmSize,
    vmLocation,
    createdAt: now,
    updatedAt: now,
  });

  // Create chat session in ProjectData DO (workspace always linked to project)
  try {
    const chatSessionId = await projectDataService.createSession(
      c.env,
      linkedProject.id,
      workspaceId,
      workspaceName
    );
    await db
      .update(schema.workspaces)
      .set({ chatSessionId, updatedAt: now })
      .where(eq(schema.workspaces.id, workspaceId));
  } catch (err) {
    // Best-effort: session creation failure should not block workspace creation
    log.error('workspace.chat_session_create_failed', { workspaceId, error: err instanceof Error ? err.message : String(err) });
  }

  const nodeCountForUser = userNodeCountVal + (mustProvisionNode ? 1 : 0);
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
        resolvedRepository,
        branch,
        auth.user.name,
        auth.user.email
      );
    })()
  );

  const created = await getOwnedWorkspace(db, workspaceId, userId);

  // Record activity event for workspace creation
  c.executionCtx.waitUntil(
    projectDataService.recordActivityEvent(
      c.env, linkedProject.id, 'workspace.created', 'user', userId,
      workspaceId, null, null, { name: created.name, repository: resolvedRepository }
    ).catch((e) => { log.warn('workspace.activity_created_failed', { workspaceId, error: String(e) }); })
  );

  return c.json(toWorkspaceResponse(created, c.env.BASE_DOMAIN), 201);
});

crudRoutes.delete('/:id', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);

  if (workspace.nodeId) {
    const node = await getOwnedNode(db, workspace.nodeId, userId);
    if (node.status === 'running' && node.healthStatus !== 'unhealthy') {
      try {
        await deleteWorkspaceOnNode(workspace.nodeId, workspace.id, c.env, userId);
      } catch (e) {
        log.error('workspace.delete_on_node_failed', { workspaceId: workspace.id, nodeId: workspace.nodeId, error: String(e) });
      }
    }
  }

  // Stop the chat session and clean up activity tracking before deleting (best-effort)
  if (workspace.projectId && workspace.chatSessionId) {
    c.executionCtx.waitUntil(
      projectDataService.stopSession(c.env, workspace.projectId, workspace.chatSessionId)
        .catch((e) => { log.warn('workspace.delete_stop_session_failed', { workspaceId: workspace.id, sessionId: workspace.chatSessionId, error: String(e) }); })
    );
    c.executionCtx.waitUntil(
      projectDataService.cleanupWorkspaceActivity(c.env, workspace.projectId, workspace.id)
        .catch((e) => { log.warn('workspace.delete_cleanup_activity_failed', { workspaceId: workspace.id, error: String(e) }); })
    );
  }

  await db.delete(schema.agentSessions).where(eq(schema.agentSessions.workspaceId, workspace.id));

  await db
    .delete(schema.workspaces)
    .where(and(eq(schema.workspaces.id, workspace.id), eq(schema.workspaces.userId, userId)));

  return c.json({ success: true });
});

export { crudRoutes };
