/**
 * Provision the reverse-tunnel (frp) side of one managed workspace node incarnation: lease a
 * loopback port on the control-plane box and mint the node's frp credential, BEFORE the
 * provider VM is requested (so every later failure can release the lease). No DNS record, no
 * Origin CA and no public IP are involved for this transport.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getReverseTunnelGatewaySecret } from './node-reverse-tunnel-config';
import {
  ensureReverseTunnelLease,
  type EnsureReverseTunnelLeaseInput,
  type ReverseTunnelLeaseProvisioning,
} from './node-reverse-tunnel-leases';
import { resolveVmAgentTunnelPort } from './node-tunnel-config';

export interface NodeReverseTunnelProvisioning extends ReverseTunnelLeaseProvisioning {
  /** The vm-agent's loopback tunnel listener port (frpc `localPort`). */
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
