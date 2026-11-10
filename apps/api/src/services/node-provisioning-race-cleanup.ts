/**
 * Compensation for a provider VM that `provisionNode` created but could not publish
 * (lifecycle or authority race). Split out of `node-provisioning.ts` (rule 18).
 */
import type { Provider, ProviderRequestContext } from '@simple-agent-manager/providers';

import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { deleteDNSRecord } from './dns';
import type { ProvisionNodeRow } from './node-provisioning-predicates';
import { deleteNodeResourcesStrict } from './strict-node-deletion';

export async function deleteCreatedProviderVmDirectly(input: {
  provider: Pick<Provider, 'deleteVM'>;
  providerInstanceId: string;
  nodeId: string;
  providerContext?: ProviderRequestContext;
}): Promise<void> {
  try {
    if (input.providerContext)
      await input.provider.deleteVM(input.providerInstanceId, input.providerContext);
    else await input.provider.deleteVM(input.providerInstanceId);
  } catch (err) {
    log.error('node_provisioning.created_vm_direct_cleanup_failed', {
      nodeId: input.nodeId,
      providerInstanceId: input.providerInstanceId,
      ...serializeError(err),
    });
  }
}

export async function cleanupCreatedVmAfterProvisioningRace(input: {
  node: ProvisionNodeRow;
  env: Env;
  provider: Pick<Provider, 'deleteVM'>;
  providerInstanceId: string;
  runtimeIncarnationId: string | null;
  backendDnsRecordId?: string | null;
  providerContext?: ProviderRequestContext;
}): Promise<void> {
  if (input.backendDnsRecordId) {
    try {
      await deleteDNSRecord(input.backendDnsRecordId, input.env, input.providerContext?.signal);
    } catch (dnsErr) {
      log.error('node_provisioning.created_vm_dns_cleanup_failed', {
        nodeId: input.node.id,
        backendDnsRecordId: input.backendDnsRecordId,
        ...serializeError(dnsErr),
      });
    }
  }

  try {
    await deleteNodeResourcesStrict(input.node.id, input.node.userId, input.env, {
      cleanupDns: false,
      providerRequestContext: input.providerContext,
      expectedRuntime: {
        userId: input.node.userId,
        runtime: input.node.runtime,
        providerInstanceId: input.providerInstanceId,
        runtimeIncarnationId: input.runtimeIncarnationId,
      },
    });
    return;
  } catch (strictErr) {
    log.error('node_provisioning.created_vm_strict_cleanup_failed', {
      nodeId: input.node.id,
      providerInstanceId: input.providerInstanceId,
      ...serializeError(strictErr),
    });
  }

  await deleteCreatedProviderVmDirectly({
    provider: input.provider,
    providerInstanceId: input.providerInstanceId,
    nodeId: input.node.id,
    providerContext: input.providerContext,
  });
}
