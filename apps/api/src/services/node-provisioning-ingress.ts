/**
 * Tunnel ingress set-up and failure settlement for `provisionNode`, one entry point per step
 * for both tunnel transports. Split out of `node-provisioning.ts` (rule 18).
 *
 * - `cloudflare-tunnel`: journal + create the incarnation's named tunnel (node-tunnel-*.ts).
 * - `reverse-tunnel`: lease the box-side loopback port and derive the frp credential
 *   (node-reverse-tunnel-*.ts).
 * Both run BEFORE the provider VM exists, so every later failure can release them.
 */
import type { NodeTransport } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { releaseNodeReverseTunnelLeases } from './node-reverse-tunnel-leases';
import {
  ensureNodeReverseTunnelForProvisioning,
  type NodeReverseTunnelProvisioning,
} from './node-reverse-tunnel-provisioning';
import { settleNodeTunnels } from './node-tunnel-cleanup';
import {
  ensureNodeTunnelForProvisioning,
  type NodeTunnelProvisioning,
} from './node-tunnel-provisioning';

export interface NodeTunnelIngress {
  tunnel: NodeTunnelProvisioning | null;
  reverseTunnel: NodeReverseTunnelProvisioning | null;
}

export interface PrepareNodeTunnelIngressInput {
  nodeId: string;
  userId: string;
  runtimeIncarnationId: string | null;
  signal?: AbortSignal;
  /** Called before any ownership write, so the caller's failure path knows to release it. */
  onOwnershipRecorded: () => void;
}

export async function prepareNodeTunnelIngress(
  env: Env,
  transport: NodeTransport | null,
  input: PrepareNodeTunnelIngressInput
): Promise<NodeTunnelIngress> {
  if (transport !== 'cloudflare-tunnel' && transport !== 'reverse-tunnel') {
    return { tunnel: null, reverseTunnel: null };
  }
  if (!input.runtimeIncarnationId) {
    throw new Error(
      transport === 'cloudflare-tunnel'
        ? 'Tunnel transport requires a runtime incarnation'
        : 'Reverse-tunnel transport requires a runtime incarnation'
    );
  }
  input.onOwnershipRecorded();
  const owner = {
    nodeId: input.nodeId,
    userId: input.userId,
    runtimeIncarnationId: input.runtimeIncarnationId,
  };
  if (transport === 'cloudflare-tunnel') {
    return {
      tunnel: await ensureNodeTunnelForProvisioning(env, { ...owner, signal: input.signal }),
      reverseTunnel: null,
    };
  }
  return { tunnel: null, reverseTunnel: await ensureNodeReverseTunnelForProvisioning(env, owner) };
}

/**
 * Provisioning failure: release every non-live incarnation's tunnel ownership of this node.
 * A possibly-created VM keeps its (live) incarnation's ownership until node teardown records
 * termination proof. Never throws; the cron sweeps are the backstop.
 */
export async function settleNodeTunnelIngress(
  env: Env,
  nodeId: string,
  reason: string
): Promise<void> {
  await settleNodeTunnels(env, nodeId, reason);
  await releaseNodeReverseTunnelLeases(env, nodeId, reason);
}
