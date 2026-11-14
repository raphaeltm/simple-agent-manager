/**
 * Providerless strict teardown: a `destroying` VM row whose provider create response was lost.
 * Split out of `strict-node-deletion.ts` (rule 18); behavior unchanged.
 */
import {
  type ProviderRequestContext,
  type VMInstance,
} from '@simple-agent-manager/providers';

import type { Env } from '../env';
import {
  buildNodeProviderLabels,
  nodeProviderLabelsMatch,
  resolveEnvironmentLabel,
  resolveInstallationId,
} from './node-provider-labels';
import {
  hasManagedVmPlacementProof,
  type NodeDb,
  type NodeRow,
  requireSameNodeIncarnation,
  requireStrictNodeProvider,
} from './strict-node-deletion-shared';
import { getProvisioningTimeoutMs } from './timeout';

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
export async function reconcileStrictProviderlessVm(
  db: NodeDb,
  node: NodeRow,
  userId: string,
  env: Env,
  requestContext?: ProviderRequestContext,
  beforeDestroy?: () => Promise<void>
): Promise<'deleted'> {
  // A node whose capacity source was released is not admitted here: the release means its
  // pinned credential was deleted, and this path resolves only that exact credential
  // (`requireStrictNodeProvider`). Such a node stays `destroying` and surfaces through
  // `node_destroying_too_long`.
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

  if (servers.some((server) => !nodeProviderLabelsMatch(server.labels, labels))) {
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
    !nodeProviderLabelsMatch(current.labels, labels)
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
