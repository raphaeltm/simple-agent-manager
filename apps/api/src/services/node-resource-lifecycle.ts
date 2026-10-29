import {
  DEFAULT_WORKSPACE_DELETION_DIAGNOSTIC_MAX_LENGTH,
  DEPLOYMENT_STOP_ERROR_PREFIX,
  isUserOwnedNodeClass,
} from '@simple-agent-manager/shared';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { deleteDNSRecord } from './dns';
import {
  type ContainerWorkspaceDeletionAuthority,
  requireNodeWorkspaceArtifactsDeleted,
} from './node-workspace-retirement-guard';
import { deleteNodeResourcesStrict, type StrictNodeRuntimeIdentity } from './strict-node-deletion';
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

async function markDeploymentStopFailed(
  db: ReturnType<typeof drizzle<typeof schema>>,
  node: schema.Node,
  message: string
): Promise<void> {
  if (node.nodeRole !== 'deployment') return;
  await db
    .update(schema.deploymentEnvironments)
    .set({
      status: 'error',
      observedStatus: 'failed',
      observedErrorMessage: `${DEPLOYMENT_STOP_ERROR_PREFIX} ${message}`,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(schema.deploymentEnvironments.nodeId, node.id),
        eq(schema.deploymentEnvironments.status, 'stopping'),
        sql`EXISTS (SELECT 1 FROM nodes n WHERE n.id = ${node.id}
      AND n.user_id = ${node.userId} AND n.status = 'destroying'
      AND n.provider_instance_id IS ${node.providerInstanceId}
      AND n.runtime_incarnation_id IS ${node.runtimeIncarnationId})`
      )
    );
}

export async function stopNodeResources(
  nodeId: string,
  userId: string,
  env: Env,
  options: {
    expectedRuntime?: StrictNodeRuntimeIdentity;
    workspaceDeletion?: ContainerWorkspaceDeletionAuthority;
  } = {}
): Promise<void> {
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

  const expected = options.expectedRuntime;
  if (
    expected &&
    (node.userId !== expected.userId ||
      node.runtime !== expected.runtime ||
      node.providerInstanceId !== expected.providerInstanceId ||
      node.runtimeIncarnationId !== expected.runtimeIncarnationId)
  ) {
    throw new Error('Managed node changed before teardown could be claimed');
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

  if (!node.runtimeTerminationConfirmedAt) {
    await requireNodeWorkspaceArtifactsDeleted(
      env,
      nodeId,
      userId,
      node,
      options.workspaceDeletion
    );
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
  if (node.nodeRole === 'deployment') {
    await db
      .update(schema.deploymentEnvironments)
      .set({ status: 'stopping', updatedAt: now })
      .where(eq(schema.deploymentEnvironments.nodeId, nodeId));
  }
  await db
    .update(schema.workspaces)
    .set({ status: 'stopping', errorMessage: managedNodeStopDiagnostic(env), updatedAt: now })
    .where(and(eq(schema.workspaces.nodeId, nodeId), eq(schema.workspaces.userId, userId)));

  let strictDeletion;
  try {
    strictDeletion = await deleteNodeResourcesStrict(nodeId, userId, env, {
      cleanupDns: false,
      workspaceDeletion: options.workspaceDeletion,
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
    await markDeploymentStopFailed(db, node, 'managed node teardown remains unconfirmed');
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
      if (node.nodeRole === 'deployment') {
        await markDeploymentStopFailed(db, node, 'node DNS cleanup remains pending');
        throw new Error('Deployment node DNS cleanup remains pending');
      }
    }
  }

  if (node.nodeRole === 'deployment') {
    await retireDeletedDeploymentNodeRecord(db, env, nodeId, userId, strictDeletion);
    return;
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
  proof: {
    runtimeTerminationConfirmedAt: string | null;
    runtimeIncarnationId: string | null;
    providerInstanceId?: string | null;
  }
): Promise<void> {
  const now = new Date().toISOString();

  const terminalProof = and(
    eq(schema.nodes.id, nodeId),
    eq(schema.nodes.userId, userId),
    eq(schema.nodes.nodeRole, 'deployment'),
    proof.runtimeTerminationConfirmedAt
      ? and(
          sql`${schema.nodes.runtimeTerminationConfirmedAt} IS ${proof.runtimeTerminationConfirmedAt}`,
          sql`${schema.nodes.runtimeIncarnationId} IS ${proof.runtimeIncarnationId}`
        )
      : eq(schema.nodes.nodeClass, 'user-owned')
  );
  const terminalFence = sql`EXISTS (SELECT 1 FROM nodes WHERE ${terminalProof}
    AND ${schema.nodes.status} = 'deleted')`;
  // D1 batches are atomic: a failure cannot commit the node tombstone while
  // leaving its environments permanently stopping. Every dependent statement
  // checks the same proof, so a lost CAS cannot mutate a new incarnation.
  const [terminalNode] = await db.batch([
    db
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
      .where(terminalProof),
    db
      .update(schema.deploymentVolumes)
      .set({
        attachedServerId: null,
        linuxDevice: null,
        status: 'available',
        updatedAt: now,
      })
      .where(
        and(
          proof.runtimeTerminationConfirmedAt && proof.providerInstanceId
            ? eq(schema.deploymentVolumes.attachedServerId, proof.providerInstanceId)
            : sql`0`,
          terminalFence,
          sql`EXISTS (SELECT 1 FROM deployment_environments de
        WHERE de.id = ${schema.deploymentVolumes.environmentId} AND de.node_id = ${nodeId})`
        )
      ),
    db
      .update(schema.deploymentEnvironments)
      .set({
        nodeId: null,
        status: 'stopped',
        observedStatus: 'stopped',
        observedErrorMessage: null,
        observedAppliedSeq: null,
        observedServicesJson: '[]',
        observedDeployStatusJson: null,
        observedDiskTelemetryJson: null,
        observedAt: now,
        updatedAt: now,
      })
      .where(and(eq(schema.deploymentEnvironments.nodeId, nodeId), terminalFence)),
    db
      .update(schema.workspaces)
      .set({ status: 'deleted', updatedAt: now })
      .where(
        and(
          eq(schema.workspaces.nodeId, nodeId),
          eq(schema.workspaces.userId, userId),
          terminalFence,
          proof.runtimeTerminationConfirmedAt
            ? eq(schema.workspaces.runtimeDeletionConfirmedAt, proof.runtimeTerminationConfirmedAt)
            : undefined
        )
      ),
  ]);
  if ((terminalNode.meta.changes ?? 0) !== 1) {
    throw new Error('Deployment node terminal proof no longer matches the current incarnation');
  }

  await finalizeWorkspaceLifecycleClosure(env, {
    nodeId,
    userId,
    agentSessionStatus: 'completed',
    nowIso: now,
    reason: 'retire_deleted_deployment_node_record',
  });
}
