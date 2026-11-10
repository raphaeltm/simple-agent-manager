/**
 * Compensation for a provider VM that `provisionNode` created but could not publish
 * (lifecycle or authority race). Split out of `node-provisioning.ts` (rule 18).
 */
import type { Provider, ProviderRequestContext } from '@simple-agent-manager/providers';

import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { deleteDNSRecord } from './dns';
import { type ProvisionNodeRow, releaseTunnelBeforeVm } from './node-provisioning-predicates';
import { deleteNodeResourcesStrict } from './strict-node-deletion';

/**
 * Last-resort provider delete after strict teardown failed. Strict teardown is what records
 * termination proof (and so releases the incarnation's Cloudflare tunnel); this fallback
 * records none, so on a confirmed delete it releases that exact incarnation's tunnel itself,
 * or the tunnel and its CNAME would outlive the VM forever.
 */
export async function deleteCreatedProviderVmDirectly(input: {
  env: Env;
  provider: Pick<Provider, 'deleteVM'>;
  providerInstanceId: string;
  nodeId: string;
  runtimeIncarnationId: string | null;
  providerContext?: ProviderRequestContext;
}): Promise<void> {
  try {
    if (input.providerContext)
      await input.provider.deleteVM(input.providerInstanceId, input.providerContext);
    else await input.provider.deleteVM(input.providerInstanceId);
    if (input.runtimeIncarnationId) {
      await releaseTunnelBeforeVm(
        input.env,
        input.nodeId,
        input.runtimeIncarnationId,
        'provider_vm_deleted_directly'
      );
    }
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
    env: input.env,
    runtimeIncarnationId: input.runtimeIncarnationId,
    provider: input.provider,
    providerInstanceId: input.providerInstanceId,
    nodeId: input.node.id,
    providerContext: input.providerContext,
  });
}
