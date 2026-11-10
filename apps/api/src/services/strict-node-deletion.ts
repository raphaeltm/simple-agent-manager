import {
  hasAmbiguousLabel,
  type ProviderRequestContext,
  type VMInstance,
} from '@simple-agent-manager/providers';
import { isUserOwnedNodeClass } from '@simple-agent-manager/shared';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { recoverLegacyDeploymentBinding } from './deployment-legacy-binding';
import { captureNodeLogsBeforeTeardown } from './node-log-capture';
import {
  buildNodeProviderLabels,
  resolveEnvironmentLabel,
  resolveInstallationId,
} from './node-provider-labels';
import { settleNodeTunnels } from './node-tunnel-cleanup';
import {
  type ContainerWorkspaceDeletionAuthority,
  requireNodeWorkspaceArtifactsDeleted,
} from './node-workspace-retirement-guard';
import type { PreservedVmRetirement } from './preserved-vm-retirement';
import {
  exactNodeIncarnationPredicate,
  hasManagedVmPlacementProof,
  type NodeDb,
  type NodeRow,
  requireSameNodeIncarnation,
  requireStrictNode,
  requireStrictNodeProvider,
  resolveStrictNodeProvider,
} from './strict-node-deletion-shared';
import { deleteStrictNodeDnsRecord } from './strict-node-dns-cleanup';
import { getProvisioningTimeoutMs } from './timeout';
import { destroyVmAgentContainer } from './vm-agent-container';

export type StrictNodeDeletionResult = {
  providerVm: 'no-instance' | 'deleted' | 'already-absent';
  runtimeTerminationConfirmedAt: string | null;
  runtimeIncarnationId: string | null;
  providerInstanceId: string | null;
};

export interface StrictNodeRuntimeIdentity {
  userId: string;
  runtime: string;
  providerInstanceId: string | null;
  runtimeIncarnationId: string | null;
}

function matchesExpectedRuntime(
  node: NodeRow,
  expected: StrictNodeRuntimeIdentity | undefined
): boolean {
  return (
    !expected ||
    (node.userId === expected.userId &&
      node.runtime === expected.runtime &&
      node.providerInstanceId === expected.providerInstanceId &&
      node.runtimeIncarnationId === expected.runtimeIncarnationId)
  );
}

async function deleteStrictProviderInstance(
  db: NodeDb,
  node: NodeRow,
  userId: string,
  env: Env,
  requestContext?: ProviderRequestContext,
  beforeDestroy?: () => Promise<void>
): Promise<StrictNodeDeletionResult['providerVm']> {
  if (!node.providerInstanceId) {
    throw new Error(
      `Cannot confirm managed VM termination for node ${node.id}: instance identity is missing`
    );
  }

  const providerResult = await resolveStrictNodeProvider(db, node, userId, env);

  await requireSameNodeIncarnation(db, node, 'provider delete');
  await beforeDestroy?.();
  // Black box recorder: bounded and best-effort, never blocks teardown beyond its timeout.
  await captureNodeLogsBeforeTeardown(env, node);
  if (requestContext)
    await providerResult.provider.deleteVM(node.providerInstanceId, requestContext);
  else await providerResult.provider.deleteVM(node.providerInstanceId);
  return 'deleted';
}

function providerInventoryMatchesLabels(
  server: VMInstance,
  labels: Record<string, string>
): boolean {
  return Object.entries(labels).every(
    ([key, value]) => !hasAmbiguousLabel(server.labels, key) && server.labels[key] === value
  );
}

function sameProviderInventoryIdentity(current: VMInstance, discovered: VMInstance): boolean {
  return (
    current.id === discovered.id &&
    current.createdAt === discovered.createdAt &&
    current.location === discovered.location &&
    current.serverType === discovered.serverType
  );
}

/**
 * Resolve a stale providerless destroy claim against the exact provider inventory.
 *
 * This path is deliberately narrower than ordinary strict deletion: the row must
 * already be destroying, carry a complete server-authored placement snapshot, and
 * resolve the exact credential generation used for allocation. Provider filtering is
 * never trusted by itself; every returned server must repeat the node, incarnation,
 * environment, installation, role, and managed labels locally. A discovered server is
 * re-read immediately before deletion. Only Hetzner's fail-closed, fully paginated
 * inventory is accepted here. Empty inventory cannot prove allocation finality;
 * retain the unresolved record so a late resource remains discoverable.
 */
async function reconcileStrictProviderlessVm(
  db: NodeDb,
  node: NodeRow,
  userId: string,
  env: Env,
  requestContext?: ProviderRequestContext,
  beforeDestroy?: () => Promise<void>
): Promise<StrictNodeDeletionResult['providerVm']> {
  if (node.status !== 'destroying' || !hasManagedVmPlacementProof(node)) {
    throw new Error(
      `Cannot confirm managed VM termination for node ${node.id}: instance identity is missing`
    );
  }
  // A fresh createVM may still be in flight. Keep every deployment entry
  // point (including direct node Stop) quarantined until the existing recovery
  // window passes for workspace nodes too; an empty inventory can be transient.
  if (
    !Number.isFinite(Date.parse(node.createdAt)) ||
    Date.now() - Date.parse(node.createdAt) < getProvisioningTimeoutMs(env)
  ) {
    throw new Error('Node allocation is still within its provisioning recovery window');
  }
  // Only Hetzner currently guarantees that a successful filtered inventory read is
  // complete. Other adapters may deliberately return partial multi-region inventory,
  // so an empty generic list cannot prove provider-side absence.
  if (node.cloudProvider !== 'hetzner') {
    throw new Error(
      `Cannot reconcile providerless VM ${node.id}: provider inventory completeness is not guaranteed`
    );
  }
  const installationId = resolveInstallationId(env);
  const environmentLabel = resolveEnvironmentLabel(env);
  if (!installationId || !environmentLabel || !node.runtimeIncarnationId) {
    throw new Error(
      `Cannot reconcile providerless VM ${node.id}: exact ownership scope is unavailable`
    );
  }

  const labels = buildNodeProviderLabels({
    nodeId: node.id,
    isDeploymentNode: node.nodeRole === 'deployment',
    environmentLabel,
    installationId,
    runtimeIncarnationId: node.runtimeIncarnationId,
  });
  const providerResult = await requireStrictNodeProvider(db, node, userId, env);
  if (providerResult.providerName !== node.cloudProvider) {
    throw new Error(
      `Cannot reconcile providerless VM ${node.id}: persisted provider binding did not resolve exactly`
    );
  }
  const servers = requestContext
    ? await providerResult.provider.listVMs(labels, requestContext)
    : await providerResult.provider.listVMs(labels);

  if (servers.some((server) => !providerInventoryMatchesLabels(server, labels))) {
    throw new Error(
      `Cannot reconcile providerless VM ${node.id}: provider inventory returned foreign or ambiguous ownership`
    );
  }
  if (servers.length > 1) {
    throw new Error(
      `Cannot reconcile providerless VM ${node.id}: provider inventory returned duplicate exact ownership`
    );
  }

  const discovered = servers[0];
  if (!discovered) {
    throw new Error(
      `Cannot reconcile providerless VM ${node.id}: allocation remains unresolved despite empty inventory`
    );
  }
  const createdAt = Date.parse(discovered.createdAt);
  const nodeCreatedAt = Date.parse(node.createdAt);
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(nodeCreatedAt) ||
    createdAt < Math.floor(nodeCreatedAt / 1000) * 1000 ||
    createdAt > Date.now() ||
    discovered.location !== node.vmLocation ||
    discovered.serverType !== node.providerInstanceType
  ) {
    throw new Error(
      `Cannot reconcile providerless VM ${node.id}: provider inventory identity is inconsistent`
    );
  }

  const current = requestContext
    ? await providerResult.provider.getVM(discovered.id, requestContext)
    : await providerResult.provider.getVM(discovered.id);
  if (
    !current ||
    !sameProviderInventoryIdentity(current, discovered) ||
    !providerInventoryMatchesLabels(current, labels)
  ) {
    throw new Error(
      `Cannot reconcile providerless VM ${node.id}: exact ownership changed before deletion`
    );
  }
  await requireSameNodeIncarnation(db, node, 'providerless inventory delete');
  await beforeDestroy?.();
  if (requestContext) await providerResult.provider.deleteVM(current.id, requestContext);
  else await providerResult.provider.deleteVM(current.id);
  return 'deleted';
}

/**
 * Release and clean the Cloudflare tunnel of every non-live incarnation of this VM node.
 * Instant (cf-container) runtimes never reach this: they never own tunnel resources.
 */
async function releaseTerminatedNodeTunnels(env: Env, nodeId: string): Promise<void> {
  await settleNodeTunnels(env, nodeId, 'runtime_terminated');
}

async function markWorkspaceRuntimeTerminationConfirmed(
  db: NodeDb,
  node: NodeRow,
  confirmedAt: string
): Promise<void> {
  await db
    .update(schema.workspaces)
    .set({
      status: 'deleted',
      errorMessage: null,
      runtimeDeletionConfirmedAt: confirmedAt,
      runtimeDeletionProof: 'node_runtime_terminated',
      updatedAt: confirmedAt,
    })
    .where(
      and(
        eq(schema.workspaces.nodeId, node.id),
        eq(schema.workspaces.userId, node.userId),
        sql`EXISTS (
          SELECT 1
            FROM nodes AS proof_node
           WHERE proof_node.id = ${node.id}
             AND proof_node.user_id IS ${node.userId}
             AND proof_node.status IS ${node.status}
             AND proof_node.runtime IS ${node.runtime}
             AND proof_node.provider_instance_id IS ${node.providerInstanceId}
             AND proof_node.runtime_incarnation_id IS ${node.runtimeIncarnationId}
             AND proof_node.runtime_termination_confirmed_at IS ${confirmedAt}
        )`
      )
    );
}

async function markRuntimeTerminationConfirmed(
  db: NodeDb,
  node: NodeRow,
  provenance: 'strict' | 'owner_attested' = 'strict'
): Promise<string> {
  await requireSameNodeIncarnation(db, node, 'termination proof write');
  const confirmedAt = new Date().toISOString();
  const result = await db
    .update(schema.nodes)
    .set({
      runtimeTerminationConfirmedAt: confirmedAt,
      // Written in the same CAS as the proof, so a reader can never see the proof
      // without its provenance. See `isOwnerAttestedTermination`.
      runtimeTerminationAttestedAt: provenance === 'owner_attested' ? confirmedAt : null,
    })
    .where(exactNodeIncarnationPredicate(node))
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new Error(`Strict node deletion proof CAS failed: node=${node.id}`);
  }
  await requireSameNodeIncarnation(
    db,
    { ...node, runtimeTerminationConfirmedAt: confirmedAt },
    'termination proof verification'
  );
  await markWorkspaceRuntimeTerminationConfirmed(db, node, confirmedAt);
  return confirmedAt;
}

/**
 * The owner states they deleted the server at their provider after SAM's strict
 * teardown could not. Writes the same proof markers as a strict delete, fenced on
 * the exact incarnation the caller loaded, so every proof reader and the shared
 * removal tail treat the node uniformly. Callers must first refuse when the
 * provider positively reports the server still exists (`services/node-manual-deletion.ts`).
 */
export async function recordOwnerAttestedRuntimeTermination(
  db: NodeDb,
  node: NodeRow
): Promise<string> {
  return await markRuntimeTerminationConfirmed(db, node, 'owner_attested');
}

/**
 * True when the node's current termination proof is the owner's attestation, not
 * SAM's strict deletion. Keyed on equality with the proof itself, so any later
 * writer that replaces or clears the proof (re-provisioning, a strict delete,
 * container recovery) ends the attestation without having to know about it.
 */
export function isOwnerAttestedTermination(
  node: Pick<NodeRow, 'runtimeTerminationConfirmedAt' | 'runtimeTerminationAttestedAt'>
): boolean {
  return (
    node.runtimeTerminationConfirmedAt !== null &&
    node.runtimeTerminationAttestedAt === node.runtimeTerminationConfirmedAt
  );
}

async function claimManagedNodeDeletion(db: NodeDb, node: NodeRow): Promise<NodeRow> {
  // Absence proof must also fence lifecycle changes: claim teardown before
  // consuming proof on any node that has not already entered terminal cleanup.
  if (
    (node.runtimeTerminationConfirmedAt && node.status === 'deleted') ||
    node.status === 'destroying'
  ) {
    return await requireSameNodeIncarnation(db, node, 'managed deletion claim');
  }

  const result = await db
    .update(schema.nodes)
    .set({ status: 'destroying', healthStatus: 'stale', updatedAt: new Date().toISOString() })
    .where(exactNodeIncarnationPredicate(node))
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new Error(`Strict node deletion claim CAS failed: node=${node.id}`);
  }
  return await requireSameNodeIncarnation(
    db,
    { ...node, status: 'destroying', healthStatus: 'stale' },
    'managed deletion claim verification'
  );
}

/**
 * Strict node teardown for cleanup paths where hiding a failed cloud delete is
 * worse than surfacing a stale D1 row. Unlike deleteNodeResources(), this does
 * not cascade workspace status; callers must update workspace rows only after
 * external resources have actually been removed.
 */
export async function deleteNodeResourcesStrict(
  nodeId: string,
  userId: string,
  env: Env,
  options: {
    cleanupDns?: boolean;
    /** Only the explicit permanent operator deletion adapter may discard local workspace data. */
    explicitPermanentDeletion?: boolean;
    boundedStrandedRetirement?: import('./bounded-stranded-retirement-authority').BoundedStrandedRetirement;
    expectedRuntime?: StrictNodeRuntimeIdentity;
    workspaceDeletion?: ContainerWorkspaceDeletionAuthority;
    preservedVm?: PreservedVmRetirement;
    providerRequestContext?: ProviderRequestContext;
    requestDeadlineMs?: number;
  } = {}
): Promise<StrictNodeDeletionResult> {
  const db = drizzle(env.DATABASE, { schema });
  let initialNode = await requireStrictNode(db, nodeId, userId);
  if (
    matchesExpectedRuntime(initialNode, options.expectedRuntime) &&
    (await recoverLegacyDeploymentBinding(env, initialNode, options.providerRequestContext?.signal))
  ) {
    initialNode = await requireStrictNode(db, nodeId, userId);
  }
  if (!matchesExpectedRuntime(initialNode, options.expectedRuntime)) {
    throw new Error(`Strict node deletion target was reincarnated before claim: node=${nodeId}`);
  }

  // User-owned (BYO) machines have no SAM-provisioned cloud VM: strict deletion of the cloud
  // instance is a no-op ("nothing to delete"), never a hard error, and NEVER a provider.deleteVM
  // against the user's hardware — even defensively if a providerInstanceId were somehow set.
  // Enrollment tunnels of user-owned machines are not managed here (node-tunnel-* covers
  // only SAM-provisioned managed nodes). See architecture-critique #2.
  if (isUserOwnedNodeClass(initialNode.nodeClass)) {
    return {
      providerVm: 'no-instance',
      runtimeTerminationConfirmedAt: null,
      runtimeIncarnationId: initialNode.runtimeIncarnationId,
      providerInstanceId: initialNode.providerInstanceId,
    };
  }

  if (options.workspaceDeletion && !options.expectedRuntime) {
    throw new Error('Exact container deletion requires expected runtime identity');
  }
  const beforeDestroy = options.explicitPermanentDeletion
    ? undefined
    : () =>
        requireNodeWorkspaceArtifactsDeleted(
          env,
          nodeId,
          userId,
          initialNode,
          options.workspaceDeletion,
          options.preservedVm,
          options.boundedStrandedRetirement
        );
  if (!initialNode.runtimeTerminationConfirmedAt) await beforeDestroy?.();
  const node = await claimManagedNodeDeletion(db, initialNode);

  if (node.runtimeTerminationConfirmedAt) {
    if (
      initialNode.status === 'destroying' &&
      node.runtime === 'vm' &&
      !node.providerInstanceId &&
      !hasManagedVmPlacementProof(initialNode)
    ) {
      throw new Error(`Providerless VM termination proof lacks managed placement: node=${nodeId}`);
    }
    await requireSameNodeIncarnation(db, node, 'existing termination proof use');
    if (options.cleanupDns !== false) {
      await deleteStrictNodeDnsRecord(
        node,
        userId,
        env,
        options.requestDeadlineMs,
        options.providerRequestContext?.signal
      );
    }
    await markWorkspaceRuntimeTerminationConfirmed(db, node, node.runtimeTerminationConfirmedAt);
    if (node.runtime === 'vm') await releaseTerminatedNodeTunnels(env, node.id);
    return {
      providerVm: node.providerInstanceId ? 'already-absent' : 'no-instance',
      runtimeTerminationConfirmedAt: node.runtimeTerminationConfirmedAt,
      runtimeIncarnationId: node.runtimeIncarnationId,
      providerInstanceId: node.providerInstanceId,
    };
  }

  if (node.runtime === 'cf-container') {
    await requireSameNodeIncarnation(db, node, 'container teardown');
    await beforeDestroy?.();
    await destroyVmAgentContainer(env, node.id);
    const runtimeTerminationConfirmedAt = await markRuntimeTerminationConfirmed(db, node);
    if (options.cleanupDns !== false) {
      await deleteStrictNodeDnsRecord(
        node,
        userId,
        env,
        options.requestDeadlineMs,
        options.providerRequestContext?.signal
      );
    }
    return {
      providerVm: 'no-instance',
      runtimeTerminationConfirmedAt,
      runtimeIncarnationId: node.runtimeIncarnationId,
      providerInstanceId: node.providerInstanceId,
    };
  }

  const providerVm =
    initialNode.status === 'destroying' && node.runtime === 'vm' && !node.providerInstanceId
      ? await reconcileStrictProviderlessVm(
          db,
          node,
          userId,
          env,
          options.providerRequestContext,
          beforeDestroy
        )
      : await deleteStrictProviderInstance(
          db,
          node,
          userId,
          env,
          options.providerRequestContext,
          beforeDestroy
        );
  const runtimeTerminationConfirmedAt = await markRuntimeTerminationConfirmed(db, node);
  // The proof makes this incarnation non-live, which releases its Cloudflare tunnel (if it
  // had one). Never throws: the tunnel journal keeps the identity for the cron sweep.
  await releaseTerminatedNodeTunnels(env, node.id);
  if (options.cleanupDns !== false) {
    await deleteStrictNodeDnsRecord(
      node,
      userId,
      env,
      options.requestDeadlineMs,
      options.providerRequestContext?.signal
    );
  }
  return {
    providerVm,
    runtimeTerminationConfirmedAt,
    runtimeIncarnationId: node.runtimeIncarnationId,
    providerInstanceId: node.providerInstanceId,
  };
}
