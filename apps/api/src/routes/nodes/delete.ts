import { isUserOwnedNodeClass } from '@simple-agent-manager/shared';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Context } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireNodeOwnership } from '../../middleware/node-auth';
import { collectEnvironmentRouteHostnames } from '../../services/deployment-routing';
import { cleanupAppRouteDNSRecords } from '../../services/dns';
import { finalizeDeletion as finalizeNodeLifecycleDeletion } from '../../services/node-lifecycle';
import type { DeleteNodeResourcesResult } from '../../services/node-resource-deletion';
import {
  listStrandedNodeTasks,
  terminalizeStrandedNodeTasks,
} from '../../services/node-stranded-tasks';
import { deleteNodeResources, retireDeletedDeploymentNodeRecord } from '../../services/nodes';
import { recordOwnerNodeDeletionAudit } from '../../services/owner-node-deletion-audit';
import { isOwnerAttestedTermination } from '../../services/strict-node-deletion';

type NodesDb = ReturnType<typeof drizzle<typeof schema>>;

function workspaceHasNoSnapshotContext() {
  // Removing a host must not erase the workspace metadata the snapshot resumer
  // needs. Retain in-flight/failed snapshots too: their context remains useful
  // for recovery and diagnostics. Explicit workspace deletion discards artifacts.
  return sql`NOT EXISTS (
    SELECT 1 FROM session_snapshots AS snapshot
    WHERE snapshot.workspace_id = ${schema.workspaces.id}
      AND snapshot.user_id = ${schema.workspaces.userId}
  )`;
}

async function cleanupHostedDeploymentRouteDns(
  db: NodesDb,
  env: Env,
  nodeId: string
): Promise<void> {
  const hostedEnvs = await db
    .select({ id: schema.deploymentEnvironments.id })
    .from(schema.deploymentEnvironments)
    .where(eq(schema.deploymentEnvironments.nodeId, nodeId));

  for (const envRow of hostedEnvs) {
    const releases = await db
      .select({ manifest: schema.deploymentReleases.manifest })
      .from(schema.deploymentReleases)
      .where(eq(schema.deploymentReleases.environmentId, envRow.id));
    const hostnames = collectEnvironmentRouteHostnames(
      releases.map((release) => release.manifest),
      {
        environmentId: envRow.id,
        baseDomain: env.BASE_DOMAIN,
        routePortBase: env.DEPLOYMENT_ROUTE_PORT_BASE,
        routePortSpan: env.DEPLOYMENT_ROUTE_PORT_SPAN,
      }
    );
    const dnsRecordsDeleted = await cleanupAppRouteDNSRecords(hostnames, env);
    log.info('node.deployment_dns_cleaned_up', {
      nodeId,
      environmentId: envRow.id,
      dnsRecordsDeleted,
    });
  }
}

async function removeManagedNodeRecords(
  db: NodesDb,
  nodeId: string,
  userId: string,
  cleanup: DeleteNodeResourcesResult
): Promise<void> {
  if (!cleanup.runtimeTerminationConfirmedAt) {
    throw errors.conflict('Managed node deletion proof is unavailable');
  }
  await db
    .delete(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.nodeId, nodeId),
        eq(schema.workspaces.userId, userId),
        eq(schema.workspaces.runtimeDeletionConfirmedAt, cleanup.runtimeTerminationConfirmedAt),
        workspaceHasNoSnapshotContext()
      )
    );
  const deletedNode = await db
    .delete(schema.nodes)
    .where(
      and(
        eq(schema.nodes.id, nodeId),
        eq(schema.nodes.userId, userId),
        sql`${schema.nodes.runtimeTerminationConfirmedAt} IS ${cleanup.runtimeTerminationConfirmedAt}`,
        sql`${schema.nodes.runtimeIncarnationId} IS ${cleanup.runtimeIncarnationId}`
      )
    )
    .run();
  // The predicate targets one primary key, but D1 also counts FK SET NULL
  // writes (for example tasks.auto_provisioned_node_id) in meta.changes.
  if ((deletedNode.meta.changes ?? 0) < 1) {
    throw errors.conflict('Managed node incarnation changed after deletion proof');
  }
}

async function removeDeletedNodeRecords(input: {
  db: NodesDb;
  env: Env;
  nodeId: string;
  userId: string;
  nodeRole: string | null;
  nodeClass: string | null;
  cleanup: DeleteNodeResourcesResult;
}): Promise<void> {
  if ((input.nodeRole ?? 'workspace') === 'deployment') {
    await retireDeletedDeploymentNodeRecord(
      input.db,
      input.env,
      input.nodeId,
      input.userId,
      input.cleanup
    );
    return;
  }
  if (isUserOwnedNodeClass(input.nodeClass)) {
    await input.db
      .delete(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.nodeId, input.nodeId),
          eq(schema.workspaces.userId, input.userId),
          workspaceHasNoSnapshotContext()
        )
      );
    await input.db
      .delete(schema.nodes)
      .where(and(eq(schema.nodes.id, input.nodeId), eq(schema.nodes.userId, input.userId)));
    return;
  }
  await removeManagedNodeRecords(input.db, input.nodeId, input.userId, input.cleanup);
}

export async function deleteNodeRoute(c: Context<{ Bindings: Env }>) {
  const nodeId = c.req.param('id');
  if (!nodeId) throw errors.badRequest('Node id is required');
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const node = await requireNodeOwnership(c, nodeId);

  if (!node) {
    throw errors.notFound('Node');
  }

  await deleteOwnedNode(c.env, db, node, userId);
  return c.json({ success: true });
}

/**
 * The whole owner node deletion once the caller is authorized for `node`: strict provider
 * teardown, then record removal. `userId` must be the node's owner. Shared by the owner's
 * Delete route and the Operations `delete_node` action, so there is one teardown path.
 * Throws a 409 when runtime termination is not proven.
 */
export async function deleteOwnedNode(
  env: Env,
  db: NodesDb,
  node: Pick<
    typeof schema.nodes.$inferSelect,
    'id' | 'nodeRole' | 'nodeClass' | 'lastHeartbeatAt' | 'createdAt'
  >,
  userId: string
): Promise<void> {
  const nodeId = node.id;
  const strandedTasks = await listStrandedNodeTasks(env, nodeId);

  const cleanup = await deleteNodeResources(nodeId, userId, env);
  if ((node.nodeRole ?? 'workspace') === 'deployment' && cleanup.errors.length > 0) {
    throw errors.conflict(
      `Deployment node could not be fully deprovisioned: ${cleanup.errors.join('; ')}`
    );
  }
  if (!cleanup.runtimeTerminationConfirmed) {
    throw errors.conflict(
      `Node runtime termination is not confirmed: ${cleanup.errors.join('; ') || 'cleanup remains pending'}`
    );
  }

  await completeOwnerNodeRemoval({
    env,
    db,
    node,
    userId,
    cleanup,
    strandedTasks,
    reason: await ownerRemovalReason(db, nodeId, cleanup.runtimeTerminationConfirmedAt),
  });
}

/**
 * A Delete can consume proof the owner attested earlier (a manual removal that
 * stopped before its removal finished). Its audit reason must still say so, or the
 * attestation would read as strict proof to anything that trusts
 * `owner_requested_node_deletion`.
 */
async function ownerRemovalReason(
  db: NodesDb,
  nodeId: string,
  proofAt: string | null
): Promise<string> {
  const [row] = await db
    .select({
      runtimeTerminationConfirmedAt: schema.nodes.runtimeTerminationConfirmedAt,
      runtimeTerminationAttestedAt: schema.nodes.runtimeTerminationAttestedAt,
    })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, nodeId))
    .limit(1);
  const attested =
    row !== undefined &&
    row.runtimeTerminationConfirmedAt === proofAt &&
    isOwnerAttestedTermination(row);
  return attested ? OWNER_ATTESTED_REMOVAL_REASON : 'owner_requested_node_deletion';
}

export const OWNER_ATTESTED_REMOVAL_REASON = 'owner_attested_manual_deletion';

/**
 * Everything an owner's node removal does once runtime termination is proven, by
 * strict deletion or by the owner's own attestation (`manual-deletion.ts`).
 */
export async function completeOwnerNodeRemoval(input: {
  env: Env;
  db: NodesDb;
  node: Pick<
    typeof schema.nodes.$inferSelect,
    'id' | 'nodeRole' | 'nodeClass' | 'lastHeartbeatAt' | 'createdAt'
  >;
  userId: string;
  cleanup: DeleteNodeResourcesResult;
  strandedTasks: Awaited<ReturnType<typeof listStrandedNodeTasks>>;
  reason: string;
}): Promise<void> {
  const { env, db, node, userId, cleanup } = input;
  const nodeId = node.id;
  // Deprovision app-route DNS records for any deployment environments hosted on
  // this node. The environment rows survive (nodeId is set null by the FK), but
  // their grey-cloud A records would otherwise point at the now-freed VM IP.
  await cleanupHostedDeploymentRouteDns(db, env, nodeId);
  await recordOwnerNodeDeletionAudit(env, node, userId, cleanup, input.reason);
  await removeDeletedNodeRecords({
    db,
    env,
    nodeId,
    userId,
    nodeRole: node.nodeRole,
    nodeClass: node.nodeClass,
    cleanup,
  });

  await finalizeNodeLifecycleDeletion(env, nodeId, userId);

  const transitionFailures = await terminalizeStrandedNodeTasks(
    env,
    nodeId,
    input.strandedTasks,
    'owner_deleted'
  );
  if (transitionFailures > 0) {
    log.error('node_delete.stranded_task_cancel_failed', { nodeId, transitionFailures });
  }
}
