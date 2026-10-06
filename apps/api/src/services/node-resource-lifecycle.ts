import {
  DEFAULT_WORKSPACE_DELETION_DIAGNOSTIC_MAX_LENGTH,
  isUserOwnedNodeClass,
} from '@simple-agent-manager/shared';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { deleteDNSRecord } from './dns';
import { deleteNodeResourcesStrict } from './strict-node-deletion';
import { WORKSPACE_DELETION_DIAGNOSTIC_PREFIX } from './workspace-deletion';
import { finalizeWorkspaceLifecycleClosure } from './workspace-lifecycle-finalizer';

function managedNodeStopDiagnostic(env: Env): string {
  const configuredMaxLength = Number.parseInt(
    env.WORKSPACE_DELETION_DIAGNOSTIC_MAX_LENGTH ?? '',
    10
  );
  const maxLength =
    Number.isInteger(configuredMaxLength) && configuredMaxLength > 0
      ? configuredMaxLength
      : DEFAULT_WORKSPACE_DELETION_DIAGNOSTIC_MAX_LENGTH;
  return `${WORKSPACE_DELETION_DIAGNOSTIC_PREFIX}: managed node teardown pending`.slice(
    0,
    maxLength
  );
}

export async function stopNodeResources(nodeId: string, userId: string, env: Env): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  const now = new Date().toISOString();

  const rows = await db
    .select()
    .from(schema.nodes)
    .where(and(eq(schema.nodes.id, nodeId), eq(schema.nodes.userId, userId)))
    .limit(1);

  const node = rows[0];
  if (!node) {
    return;
  }

  // User-owned (BYO) machines are the user's hardware, never SAM-provisioned infrastructure. "Stop"
  // means take the node offline, NOT destroy it: never delete a cloud VM (there is none), never
  // delete the tunnel CNAME, and keep the node record so the enrolled machine can reconnect. This
  // centralized guard also protects the markIdle failure-fallback that reaches stopNodeResources.
  // See architecture-critique #2.
  if (isUserOwnedNodeClass(node.nodeClass)) {
    await db
      .update(schema.workspaces)
      .set({ status: 'deleted', updatedAt: now })
      .where(and(eq(schema.workspaces.nodeId, nodeId), eq(schema.workspaces.userId, userId)));
    await finalizeWorkspaceLifecycleClosure(env, {
      nodeId,
      userId,
      agentSessionStatus: 'stopped',
      nowIso: now,
      reason: 'stop_node_resources_user_owned_offline',
    });
    await db
      .update(schema.nodes)
      .set({ status: 'stopped', healthStatus: 'unhealthy', updatedAt: now })
      .where(and(eq(schema.nodes.id, nodeId), eq(schema.nodes.userId, userId)));
    log.info('node_stop.user_owned_offline', { nodeId, action: 'marked_offline' });
    return;
  }

  // A managed stop is terminal only after the strict provider/container boundary
  // supplies proof. Persist quarantine before I/O so timeouts, provider errors,
  // and process interruption cannot strand a workspace in an apparently terminal state.
  const nodeClaim = await db
    .update(schema.nodes)
    .set({ status: 'destroying', healthStatus: 'stale', updatedAt: now })
    .where(
      and(
        eq(schema.nodes.id, nodeId),
        eq(schema.nodes.userId, userId),
        sql`${schema.nodes.status} IS ${node.status}`,
        sql`${schema.nodes.runtime} IS ${node.runtime}`,
        sql`${schema.nodes.providerInstanceId} IS ${node.providerInstanceId}`,
        sql`${schema.nodes.runtimeIncarnationId} IS ${node.runtimeIncarnationId}`
      )
    )
    .run();
  if ((nodeClaim.meta.changes ?? 0) !== 1) {
    throw new Error('Managed node changed before teardown could be claimed');
  }
  await db
    .update(schema.workspaces)
    .set({ status: 'stopping', errorMessage: managedNodeStopDiagnostic(env), updatedAt: now })
    .where(and(eq(schema.workspaces.nodeId, nodeId), eq(schema.workspaces.userId, userId)));

  let strictDeletion;
  try {
    strictDeletion = await deleteNodeResourcesStrict(nodeId, userId, env, {
      cleanupDns: false,
      expectedRuntime: {
        userId: node.userId,
        runtime: node.runtime,
        providerInstanceId: node.providerInstanceId,
        runtimeIncarnationId: node.runtimeIncarnationId,
      },
    });
  } catch (err) {
    log.error('node_stop.runtime_termination_unconfirmed', {
      nodeId,
      ...serializeError(err),
    });
    throw new Error('Managed node teardown remains unconfirmed');
  }
  if (!strictDeletion.runtimeTerminationConfirmedAt) {
    throw new Error('Managed node teardown returned no strict termination proof');
  }

  // Delete the DNS record since the node is being permanently stopped
  if (node.backendDnsRecordId) {
    try {
      await deleteDNSRecord(node.backendDnsRecordId, env);
    } catch (err) {
      log.error('node_stop.delete_dns_failed', { nodeId, ...serializeError(err) });
    }
  }

  // The node may have been reprovisioned while the provider call was in flight.
  // Only the exact incarnation carrying strict proof may cross the terminal fence.
  const terminalNode = await db
    .update(schema.nodes)
    .set({
      status: 'deleted',
      healthStatus: 'stale',
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.nodes.id, nodeId),
        eq(schema.nodes.userId, userId),
        eq(schema.nodes.status, 'destroying'),
        sql`${schema.nodes.runtimeTerminationConfirmedAt} IS ${strictDeletion.runtimeTerminationConfirmedAt}`,
        sql`${schema.nodes.runtimeIncarnationId} IS ${strictDeletion.runtimeIncarnationId}`
      )
    )
    .run();
  if ((terminalNode.meta.changes ?? 0) !== 1) {
    throw new Error('Managed node teardown proof no longer matches the current incarnation');
  }

  await db
    .update(schema.workspaces)
    .set({
      status: 'deleted',
      errorMessage: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.workspaces.nodeId, nodeId),
        eq(schema.workspaces.userId, userId),
        eq(schema.workspaces.status, 'stopping'),
        eq(
          schema.workspaces.runtimeDeletionConfirmedAt,
          strictDeletion.runtimeTerminationConfirmedAt
        )
      )
    );

  const confirmedWorkspaces = await db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.nodeId, nodeId),
        eq(schema.workspaces.userId, userId),
        eq(
          schema.workspaces.runtimeDeletionConfirmedAt,
          strictDeletion.runtimeTerminationConfirmedAt
        )
      )
    );
  await finalizeWorkspaceLifecycleClosure(env, {
    workspaceIds: confirmedWorkspaces.map((workspace) => workspace.id),
    userId,
    agentSessionStatus: 'stopped',
    nowIso: now,
    reason: 'stop_node_resources',
  });
}

export async function retireDeletedDeploymentNodeRecord(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: Env,
  nodeId: string,
  userId: string,
  proof: { runtimeTerminationConfirmedAt: string | null; runtimeIncarnationId: string | null }
): Promise<void> {
  const now = new Date().toISOString();

  const terminalNode = await db
    .update(schema.nodes)
    .set({
      status: 'deleted',
      healthStatus: 'stale',
      providerInstanceId: null,
      backendDnsRecordId: null,
      ipAddress: null,
      errorMessage: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.nodes.id, nodeId),
        eq(schema.nodes.userId, userId),
        eq(schema.nodes.nodeRole, 'deployment'),
        proof.runtimeTerminationConfirmedAt
          ? and(
              sql`${schema.nodes.runtimeTerminationConfirmedAt} IS ${proof.runtimeTerminationConfirmedAt}`,
              sql`${schema.nodes.runtimeIncarnationId} IS ${proof.runtimeIncarnationId}`
            )
          : eq(schema.nodes.nodeClass, 'user-owned')
      )
    )
    .run();
  if ((terminalNode.meta.changes ?? 0) !== 1) {
    throw new Error('Deployment node terminal proof no longer matches the current incarnation');
  }

  await db
    .update(schema.deploymentEnvironments)
    .set({
      nodeId: null,
      status: 'stopped',
      observedStatus: 'stopped',
      observedErrorMessage: null,
      observedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.deploymentEnvironments.nodeId, nodeId));

  await db
    .update(schema.workspaces)
    .set({ status: 'deleted', updatedAt: now })
    .where(
      and(
        eq(schema.workspaces.nodeId, nodeId),
        eq(schema.workspaces.userId, userId),
        proof.runtimeTerminationConfirmedAt
          ? eq(schema.workspaces.runtimeDeletionConfirmedAt, proof.runtimeTerminationConfirmedAt)
          : undefined
      )
    );

  await finalizeWorkspaceLifecycleClosure(env, {
    nodeId,
    userId,
    agentSessionStatus: 'completed',
    nowIso: now,
    reason: 'retire_deleted_deployment_node_record',
  });
}
