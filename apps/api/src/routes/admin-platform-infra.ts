import type {
  AdminPlatformInfraResponse,
  PlatformInfraNodeAssociation,
  PlatformInfraNodeSummary,
  PlatformInfraTrialSummary,
  PlatformInfraUserOption,
  UpsertPlatformInfraAssociationRequest,
} from '@simple-agent-manager/shared';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getUserId, requireAdmin, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { jsonValidator,UpsertPlatformInfraAssociationSchema } from '../schemas';

const adminPlatformInfraRoutes = new Hono<{ Bindings: Env }>();

adminPlatformInfraRoutes.use('/*', requireAuth(), requireApproved(), requireAdmin());

adminPlatformInfraRoutes.get('/', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });

  const [nodes, users] = await Promise.all([
    db
      .select()
      .from(schema.nodes)
      .where(
        and(
          eq(schema.nodes.credentialSource, 'platform'),
          ne(schema.nodes.status, 'deleted'),
        ),
      )
      .orderBy(desc(schema.nodes.createdAt)),
    db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
      })
      .from(schema.users)
      .where(eq(schema.users.status, 'active'))
      .orderBy(schema.users.email),
  ]);

  const nodeIds = nodes.map((node) => node.id);
  const workspaceRows = nodeIds.length === 0
    ? []
    : await db
        .select({
          id: schema.workspaces.id,
          nodeId: schema.workspaces.nodeId,
          status: schema.workspaces.status,
          projectId: schema.workspaces.projectId,
        })
        .from(schema.workspaces)
        .where(
          and(
            inArray(schema.workspaces.nodeId, nodeIds),
            ne(schema.workspaces.status, 'deleted'),
          ),
        );

  const associationRows = nodeIds.length === 0
    ? []
    : await db
        .select()
        .from(schema.platformNodeAssociations)
        .where(inArray(schema.platformNodeAssociations.nodeId, nodeIds));

  const trialProjectIds = Array.from(
    new Set(workspaceRows.map((workspace) => workspace.projectId).filter((value): value is string => Boolean(value))),
  );
  const trialRows = trialProjectIds.length === 0
    ? []
    : await db
        .select()
        .from(schema.trials)
        .where(inArray(schema.trials.projectId, trialProjectIds));

  const associationUserIds = Array.from(
    new Set(associationRows.map((association) => association.userId)),
  );
  const associationUsers = associationUserIds.length === 0
    ? []
    : await db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          name: schema.users.name,
        })
        .from(schema.users)
        .where(inArray(schema.users.id, associationUserIds));

  const workspaceCountByNode = new Map<string, number>();
  const activeWorkspaceCountByNode = new Map<string, number>();
  for (const workspace of workspaceRows) {
    if (!workspace.nodeId) continue;
    workspaceCountByNode.set(workspace.nodeId, (workspaceCountByNode.get(workspace.nodeId) ?? 0) + 1);
    if (workspace.status === 'running' || workspace.status === 'creating' || workspace.status === 'recovery') {
      activeWorkspaceCountByNode.set(
        workspace.nodeId,
        (activeWorkspaceCountByNode.get(workspace.nodeId) ?? 0) + 1,
      );
    }
  }

  const workspaceByProjectId = new Map<string, typeof workspaceRows[number]>();
  for (const workspace of workspaceRows) {
    if (workspace.projectId && !workspaceByProjectId.has(workspace.projectId)) {
      workspaceByProjectId.set(workspace.projectId, workspace);
    }
  }

  const trialByNodeId = new Map<string, PlatformInfraTrialSummary>();
  for (const trial of trialRows) {
    if (!trial.projectId) continue;
    const workspace = workspaceByProjectId.get(trial.projectId);
    if (!workspace?.nodeId || trialByNodeId.has(workspace.nodeId)) continue;
    trialByNodeId.set(workspace.nodeId, {
      id: trial.id,
      status: trial.status,
      repoOwner: trial.repoOwner,
      repoName: trial.repoName,
      claimedByUserId: trial.claimedByUserId ?? null,
    });
  }

  const associationUserById = new Map(associationUsers.map((user) => [user.id, user]));
  const associationByNodeId = new Map<string, PlatformInfraNodeAssociation>();
  for (const association of associationRows) {
    const user = associationUserById.get(association.userId);
    if (!user) continue;
    associationByNodeId.set(association.nodeId, {
      nodeId: association.nodeId,
      userId: association.userId,
      userEmail: user.email,
      userName: user.name,
      reason: association.reason as PlatformInfraNodeAssociation['reason'],
      associatedBy: association.associatedBy,
      createdAt: association.createdAt,
      updatedAt: association.updatedAt,
    });
  }

  const response: AdminPlatformInfraResponse = {
    nodes: nodes.map((node): PlatformInfraNodeSummary => ({
      id: node.id,
      ownerUserId: node.userId,
      name: node.name,
      status: node.status,
      healthStatus: node.healthStatus,
      cloudProvider: node.cloudProvider ?? null,
      vmSize: node.vmSize,
      vmLocation: node.vmLocation,
      credentialSource: node.credentialSource ?? null,
      lastHeartbeatAt: node.lastHeartbeatAt,
      errorMessage: node.errorMessage,
      createdAt: node.createdAt,
      workspaceCount: workspaceCountByNode.get(node.id) ?? 0,
      activeWorkspaceCount: activeWorkspaceCountByNode.get(node.id) ?? 0,
      trial: trialByNodeId.get(node.id) ?? null,
      association: associationByNodeId.get(node.id) ?? null,
    })),
    users: users.map((user): PlatformInfraUserOption => ({
      id: user.id,
      email: user.email,
      name: user.name,
    })),
  };

  return c.json(response);
});

adminPlatformInfraRoutes.put(
  '/nodes/:nodeId/association',
  jsonValidator(UpsertPlatformInfraAssociationSchema),
  async (c) => {
    const nodeId = c.req.param('nodeId');
    const body = c.req.valid('json') as UpsertPlatformInfraAssociationRequest;
    const actingUserId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });

    const [node, user] = await Promise.all([
      db
        .select({
          id: schema.nodes.id,
          credentialSource: schema.nodes.credentialSource,
          status: schema.nodes.status,
        })
        .from(schema.nodes)
        .where(eq(schema.nodes.id, nodeId))
        .limit(1),
      db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          name: schema.users.name,
          status: schema.users.status,
        })
        .from(schema.users)
        .where(eq(schema.users.id, body.userId))
        .limit(1),
    ]);

    const targetNode = node[0];
    if (!targetNode || targetNode.status === 'deleted') {
      throw errors.notFound('Node');
    }
    if (targetNode.credentialSource !== 'platform') {
      throw errors.badRequest('Only platform-managed nodes can be associated');
    }

    const targetUser = user[0];
    if (!targetUser || targetUser.status !== 'active') {
      throw errors.badRequest('Target user must be active');
    }

    const now = new Date().toISOString();
    const existing = await db
      .select({
        nodeId: schema.platformNodeAssociations.nodeId,
        createdAt: schema.platformNodeAssociations.createdAt,
      })
      .from(schema.platformNodeAssociations)
      .where(eq(schema.platformNodeAssociations.nodeId, nodeId))
      .limit(1);

    if (existing[0]) {
      await db
        .update(schema.platformNodeAssociations)
        .set({
          userId: body.userId,
          reason: body.reason,
          associatedBy: actingUserId,
          updatedAt: now,
        })
        .where(eq(schema.platformNodeAssociations.nodeId, nodeId));
    } else {
      await db.insert(schema.platformNodeAssociations).values({
        nodeId,
        userId: body.userId,
        reason: body.reason,
        associatedBy: actingUserId,
        createdAt: now,
        updatedAt: now,
      });
    }

    const response: PlatformInfraNodeAssociation = {
      nodeId,
      userId: targetUser.id,
      userEmail: targetUser.email,
      userName: targetUser.name,
      reason: body.reason,
      associatedBy: actingUserId,
      createdAt: existing[0]?.createdAt ?? now,
      updatedAt: now,
    };

    return c.json(response);
  },
);

adminPlatformInfraRoutes.delete('/nodes/:nodeId/association', async (c) => {
  const nodeId = c.req.param('nodeId');
  const db = drizzle(c.env.DATABASE, { schema });

  const targetNode = await db
    .select({
      id: schema.nodes.id,
      credentialSource: schema.nodes.credentialSource,
      status: schema.nodes.status,
    })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, nodeId))
    .limit(1);

  const node = targetNode[0];
  if (!node || node.status === 'deleted') {
    throw errors.notFound('Node');
  }
  if (node.credentialSource !== 'platform') {
    throw errors.badRequest('Only platform-managed nodes can be disassociated');
  }

  await db
    .delete(schema.platformNodeAssociations)
    .where(eq(schema.platformNodeAssociations.nodeId, nodeId));

  return c.json({ success: true });
});

export { adminPlatformInfraRoutes };
