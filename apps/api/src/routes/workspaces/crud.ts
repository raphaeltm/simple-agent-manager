import { DEFAULT_VM_LOCATION,DEFAULT_VM_SIZE } from '@simple-agent-manager/shared';
import { and, count, desc, eq, inArray, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { toWorkspaceResponse } from '../../lib/mappers';
import { ulid } from '../../lib/ulid';
import { getAuth, getUserId, requireApproved,requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireProjectCapability } from '../../middleware/project-auth';
import { CreateWorkspaceSchema,jsonValidator, UpdateWorkspacePortsPublicSchema, UpdateWorkspaceSchema } from '../../schemas';
import { startComputeTracking } from '../../services/compute-usage';
import { signPortAccessToken } from '../../services/jwt';
import { getRuntimeLimits } from '../../services/limits';
import {
  getWorkspacePortsOnNode,
  waitForNodeAgentReady,
} from '../../services/node-agent';
import { createNodeRecord, provisionNode } from '../../services/nodes';
import * as projectDataService from '../../services/project-data';
import { recordNodeRoutingMetric } from '../../services/telemetry';
import { cleanupWorkspaceForDeletion } from '../../services/workspace-cleanup';
import { resolveUniqueWorkspaceDisplayName } from '../../services/workspace-names';
import { requireRepositoryUserAccess } from '../projects/_helpers';
import { getOwnedNode, getOwnedWorkspace, scheduleWorkspaceCreateOnNode } from './_helpers';

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

crudRoutes.get('/:id/port-access', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const portParam = c.req.query('port');
  if (!portParam || !/^\d+$/.test(portParam)) {
    throw errors.badRequest('port query parameter is required and must be a number');
  }
  const port = parseInt(portParam, 10);
  if (port < 1 || port > 65535) {
    throw errors.badRequest('port must be between 1 and 65535');
  }

  const db = drizzle(c.env.DATABASE, { schema });
  // Verify ownership
  await getOwnedWorkspace(db, workspaceId, userId);

  const token = await signPortAccessToken(userId, workspaceId, port, c.env);
  const portUrl = `https://ws-${workspaceId.toLowerCase()}--${port}.${c.env.BASE_DOMAIN}/?port_token=${encodeURIComponent(token)}`;

  // Return JSON when client prefers it (CLI), redirect otherwise (browser)
  const accept = c.req.header('Accept') ?? '';
  if (accept.includes('application/json')) {
    return c.json({ token, url: portUrl, port });
  }
  return c.redirect(portUrl, 302);
});

crudRoutes.get('/:id/ports', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!workspace.nodeId) {
    throw errors.badRequest('Workspace has no node assigned');
  }
  if (workspace.status !== 'running' && workspace.status !== 'recovery') {
    throw errors.badRequest(`Workspace is ${workspace.status}, not running`);
  }

  const result = await getWorkspacePortsOnNode(workspace.nodeId, workspaceId, c.env, userId);
  return c.json(result);
});

crudRoutes.patch('/:id/ports-public', requireAuth(), requireApproved(), jsonValidator(UpdateWorkspacePortsPublicSchema), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const body = c.req.valid('json');
  const db = drizzle(c.env.DATABASE, { schema });

  await getOwnedWorkspace(db, workspaceId, userId);

  const [updated] = await db
    .update(schema.workspaces)
    .set({
      portsPublicEnabled: body.enabled,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.userId, userId)))
    .returning();

  if (!updated) {
    throw errors.notFound('Workspace not found');
  }

  return c.json(toWorkspaceResponse(updated, c.env.BASE_DOMAIN));
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

  const linkedProject = await requireProjectCapability(db, projectId, userId, 'workspace:write');
  const resolvedInstallationId = linkedProject.installationId;
  const resolvedRepository = linkedProject.repository;
  const resolvedBranch = body.branch?.trim() || linkedProject.defaultBranch;

  if (!resolvedRepository || !resolvedInstallationId) {
    throw errors.badRequest('repository and installationId are required');
  }
  const normalizedRepository = resolvedRepository.toLowerCase();

  // Fail-fast user∩app GitHub repo-access gate. Re-verify the user still has
  // access to the bound repository through the app installation BEFORE
  // provisioning any node or creating any workspace. Throws 403 if access was
  // revoked or the repository id drifted. Also covers installation ownership
  // (via requireOwnedInstallation), so no separate ownership query is needed.
  await requireRepositoryUserAccess(c, db, linkedProject, userId);

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
  let credentialAttributionSource: import('@simple-agent-manager/shared').CredentialSource = 'user';
  // Use COUNT instead of fetching all node IDs (P1 fix).
  // Exclude deleted/stopped nodes — only active ones count toward the limit.
  const [userNodeCount] = await db
    .select({ count: count() })
    .from(schema.nodes)
    .where(and(
      eq(schema.nodes.userId, userId),
      inArray(schema.nodes.status, ['running', 'creating', 'recovery']),
      eq(schema.nodes.nodeRole, 'workspace')
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

    const { resolveCredentialSource } = await import('../../services/provider-credentials');
    const credResult = await resolveCredentialSource(db, userId, body.provider, linkedProject.id);
    if (!credResult) {
      throw errors.forbidden('Cloud provider credentials required. Connect your account in Settings.');
    }
    credentialAttributionSource = credResult.credentialSource;
    const effectiveProvider = body.provider ?? credResult.providerName;

    const createdNode = await createNodeRecord(c.env, {
      userId,
      credentialAttributionUserId: userId,
      credentialAttributionProjectId: credentialAttributionSource === 'project' ? linkedProject.id : null,
      credentialAttributionSource,
      name: `${workspaceName} Node`,
      vmSize,
      vmLocation,
      cloudProvider: effectiveProvider,
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

  const chatTaskId = ulid();
  await db.insert(schema.tasks).values({
    id: chatTaskId, projectId: linkedProject.id, userId, workspaceId,
    title: workspaceName, status: 'queued', executionStep: 'workspace_creation',
    taskMode: 'conversation', triggeredBy: 'user',
    credentialAttributionUserId: userId, credentialAttributionSource,
    createdBy: userId, createdAt: now, updatedAt: now,
  });

  // Create chat session in ProjectData DO (workspace always linked to project)
  try {
    const chatSessionId = await projectDataService.createSession(
      c.env,
      linkedProject.id,
      workspaceId,
      workspaceName,
      chatTaskId,
      userId
    );
    await db
      .update(schema.workspaces)
      .set({ chatSessionId, updatedAt: now })
      .where(eq(schema.workspaces.id, workspaceId));
    await db.update(schema.tasks).set({
      chatSessionId, status: "in_progress", executionStep: "workspace_ready", updatedAt: now,
    }).where(eq(schema.tasks.id, chatTaskId));
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

  // Start compute usage metering (best-effort — failure should not block workspace creation)
  try {
    const [nodeRow] = await db
      .select({
        cloudProvider: schema.nodes.cloudProvider,
        credentialSource: schema.nodes.credentialSource,
      })
      .from(schema.nodes)
      .where(eq(schema.nodes.id, targetNodeId))
      .limit(1);
    await startComputeTracking(db, {
      userId,
      workspaceId,
      nodeId: targetNodeId,
      vmSize,
      cloudProvider: nodeRow?.cloudProvider,
      credentialSource: (nodeRow?.credentialSource as import('@simple-agent-manager/shared').CredentialSource) ?? 'user',
    });
  } catch (err) {
    log.error('workspace.compute_tracking_start_failed', {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

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
        linkedProject,
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

  await cleanupWorkspaceForDeletion({
    db,
    env: c.env,
    workspace,
    userId,
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  });

  return c.json({ success: true });
});

export { crudRoutes };
