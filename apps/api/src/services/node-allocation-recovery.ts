import {
  hasAmbiguousLabel,
  type Provider,
  type ProviderRequestContext,
  type VMInstance,
} from '@simple-agent-manager/providers';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import {
  buildNodeProviderLabels,
  resolveEnvironmentLabel,
  resolveInstallationId,
} from './node-provider-labels';

/** A transport interruption or empty inventory cannot establish that no VM was allocated. */
export class NodeAllocationUncertainError extends Error {
  constructor(
    message = 'Provider allocation is unresolved; exact resource reconciliation is required'
  ) {
    super(message);
    this.name = 'NodeAllocationUncertainError';
  }
}

export interface DurableNodeAllocation {
  createdAt: number;
  initialIncarnationId: string;
  incarnationId: string;
  /**
   * Whether any attempt of this allocation may already have sent the provider create POST.
   * `false` is positive evidence that none did, so a resumed attempt may create. Anything else
   * (`true`, or `undefined` for intents persisted before this field existed) means a VM may
   * exist and a resume must reconcile the exact inventory instead of creating again.
   */
  providerCreateRequested?: boolean;
  /**
   * Durably records that a create POST is about to be sent, BEFORE it is sent. Must throw when
   * the record cannot be made, so an unrecorded create is never sent.
   */
  markProviderCreateRequested?: () => Promise<void>;
}

/** True when a resumed attempt must reconcile inventory rather than create (see above). */
export function durableAllocationMayHaveCreated(allocation: DurableNodeAllocation): boolean {
  return allocation.providerCreateRequested !== false;
}

/** Only the exact persisted create incarnation may supply a lost provider response. */
export async function recoverNodeAllocation(
  provider: Provider,
  node: typeof schema.nodes.$inferSelect,
  env: Env,
  allocation: DurableNodeAllocation,
  context?: ProviderRequestContext
): Promise<VMInstance> {
  const installationId = resolveInstallationId(env);
  const environmentLabel = resolveEnvironmentLabel(env);
  if (!installationId || !environmentLabel)
    throw new NodeAllocationUncertainError('Allocation ownership scope is unavailable');
  const labels = buildNodeProviderLabels({
    nodeId: node.id,
    isDeploymentNode: false,
    installationId,
    environmentLabel,
    runtimeIncarnationId: allocation.incarnationId,
  });
  const servers = await provider.listVMs(labels, context);
  // Do not trust provider filtering. Every result must prove exact ownership locally.
  const exact = servers.filter((server) =>
    Object.entries(labels).every(
      ([key, value]) => !hasAmbiguousLabel(server.labels, key) && server.labels[key] === value
    )
  );
  if (exact.length !== 1)
    throw new NodeAllocationUncertainError(
      exact.length === 0
        ? 'Allocation inventory has no exact match; a second create is forbidden'
        : 'Allocation inventory has multiple exact matches; operator recovery is required'
    );
  const listed = exact[0];
  if (!listed) throw new NodeAllocationUncertainError();
  // Inventory reads may omit native hardware (GCP lists without machineTypes.get). Re-read the
  // exact instance by id for the observed identity, and require it to be the same resource with
  // the same exact ownership labels.
  const vm =
    listed.observedHardware.resources.source === 'observed'
      ? listed
      : await provider.getVM(listed.id, context);
  if (
    !vm ||
    vm.id !== listed.id ||
    !Object.entries(labels).every(
      ([key, value]) => !hasAmbiguousLabel(vm.labels, key) && vm.labels[key] === value
    )
  ) {
    throw new NodeAllocationUncertainError('Allocation inventory identity changed during recovery');
  }
  if (
    (node.providerInstanceId && node.providerInstanceId !== vm.id) ||
    vm.location !== node.vmLocation ||
    Date.parse(vm.createdAt) < Math.floor(allocation.createdAt / 1000) * 1000 ||
    Date.parse(vm.createdAt) > Date.now() ||
    vm.serverType !== node.providerInstanceType ||
    vm.observedHardware.serverType.source !== 'observed' ||
    vm.observedHardware.serverType.value !== node.providerInstanceType ||
    vm.observedHardware.resources.source !== 'observed' ||
    !Number.isFinite(Date.parse(vm.createdAt))
  ) {
    throw new NodeAllocationUncertainError(
      'Allocation inventory identity or native hardware is inconsistent'
    );
  }
  return vm;
}
