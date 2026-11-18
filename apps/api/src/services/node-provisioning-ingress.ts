/** Common ownership boundary, used by Cloudflare and separately installed transport builds. */
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { type NodeBootRenderer, nodeTransportExtension } from './node-transport-extension';
import { releaseNodeTunnels, settleNodeTunnels } from './node-tunnel-cleanup';
import { releaseUnallocatedNodeTunnel } from './node-tunnel-journal';
import {
  ensureNodeTunnelForProvisioning,
  type NodeTunnelProvisioning,
  type NodeTunnelProvisioningPhase,
} from './node-tunnel-provisioning';

export interface NodeTunnelIngress {
  tunnel: NodeTunnelProvisioning | null;
  renderCloudInit?: NodeBootRenderer;
}
export async function prepareNodeTunnelIngress(
  env: Env,
  transport: string | null,
  input: {
    nodeId: string;
    userId: string;
    runtimeIncarnationId: string | null;
    signal?: AbortSignal;
    onOwnershipRecorded: () => void;
    onPhase?: (phase: NodeTunnelProvisioningPhase) => void;
  }
): Promise<NodeTunnelIngress> {
  if (!transport || transport === 'vm-public-dns') return { tunnel: null };
  if (!input.runtimeIncarnationId)
    throw new Error('Tunnel transport requires a runtime incarnation');
  const owner = { ...input, runtimeIncarnationId: input.runtimeIncarnationId };
  input.onOwnershipRecorded();
  if (transport === 'cloudflare-tunnel') {
    return { tunnel: await ensureNodeTunnelForProvisioning(env, owner) };
  }
  const adapter = nodeTransportExtension(transport);
  if (!adapter) throw new Error(`Transport ${transport} is unavailable in this build`);
  return { tunnel: null, renderCloudInit: await adapter.prepare(env, owner) };
}

/** Exact incarnation proof: no provider POST, or confirmed direct provider deletion. */
export async function releaseNodeIngressBeforeVm(
  env: Env,
  nodeId: string,
  incarnation: string,
  reason: string
): Promise<void> {
  const release = async (operation: () => Promise<unknown> | undefined): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      log.error('node_provisioning.tunnel_release_failed', {
        nodeId,
        runtimeIncarnationId: incarnation,
        ...serializeError(error),
      });
    }
  };
  await release(() => releaseUnallocatedNodeTunnel(env, nodeId, incarnation, reason));
  await release(() =>
    nodeTransportExtension()?.releaseUnallocated(env, nodeId, incarnation, reason)
  );
}
export async function releaseTerminatedNodeIngress(
  env: Env,
  node: { id: string; runtime: string; transport: string | null },
  reason = 'runtime_terminated'
): Promise<void> {
  if (node.runtime !== 'vm') return;
  if (node.transport === 'cloudflare-tunnel') {
    await releaseNodeTunnels(env, node.id, reason);
  } else {
    await nodeTransportExtension(node.transport)?.releaseNonLive(env, node.id, reason);
  }
}
export async function settleNodeTunnelIngress(
  env: Env,
  nodeId: string,
  reason: string
): Promise<void> {
  await settleNodeTunnels(env, nodeId, reason);
  await nodeTransportExtension()?.releaseNonLive(env, nodeId, reason);
}
