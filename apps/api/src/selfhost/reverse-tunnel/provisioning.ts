import { log } from '../../lib/logger';
import { resolveVmAgentTunnelPort } from '../../services/node-tunnel-config';
import { getReverseTunnelGatewaySecret } from './config';
import type { ReverseTunnelEnv as Env } from './env';
import {
  ensureReverseTunnelLease,
  type EnsureReverseTunnelLeaseInput,
  type ReverseTunnelLeaseProvisioning,
} from './leases';

export interface NodeReverseTunnelProvisioning extends ReverseTunnelLeaseProvisioning {
    localPort: string;
}

export async function ensureNodeReverseTunnelForProvisioning(
  env: Env,
  input: EnsureReverseTunnelLeaseInput
): Promise<NodeReverseTunnelProvisioning> {
  // Without the gateway secret the frps plugin endpoint refuses every login, so the node
  // could never be reached. Fail before paying for a VM.
  if (!getReverseTunnelGatewaySecret(env)) {
    throw new Error(
      'VM_AGENT_TRANSPORT=reverse-tunnel requires REVERSE_TUNNEL_GATEWAY_SECRET (at least 32 characters)'
    );
  }
  const localPort = resolveVmAgentTunnelPort(env);
  const lease = await ensureReverseTunnelLease(env, input);
  log.info('node_reverse_tunnel.leased', {
    nodeId: input.nodeId,
    runtimeIncarnationId: input.runtimeIncarnationId,
    leaseId: lease.leaseId,
    port: lease.port,
  });
  return { ...lease, localPort };
}
