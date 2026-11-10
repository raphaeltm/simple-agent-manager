/**
 * Transport selection and tunnel configuration for managed workspace VM nodes.
 *
 * `VM_AGENT_TRANSPORT='cloudflare-tunnel'` opts NEW managed workspace VM nodes into an
 * outbound-only Cloudflare named tunnel. Everything else keeps the legacy public-IP
 * transport unchanged. Deployment-role nodes and Instant (cf-container) runtimes are
 * deliberately excluded: deployment nodes serve public app routes on their own IP, and a
 * container runtime has no VM to run cloudflared on.
 */
import type { NodeTransport } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { getNodeBackendHostname } from './dns-core';

/** Loopback port of the VM agent's dedicated, externally-classified tunnel listener. */
export const DEFAULT_VM_AGENT_TUNNEL_PORT = '8444';

/**
 * Tunnel transport knobs. Declared locally so this module compiles before the shared `Env`
 * declares them; `Env & TunnelTransportEnv` stays correct once it does.
 */
export interface TunnelTransportEnv {
  VM_AGENT_TRANSPORT?: string;
  VM_AGENT_TUNNEL_PORT?: string;
  CLOUDFLARED_VERSION?: string;
}

export type TunnelEnv = Env & TunnelTransportEnv;

export interface ManagedNodeTransportInput {
  isDeploymentNode: boolean;
  runtime: string;
  nodeClass: string;
}

/**
 * The transport a NEW managed node incarnation is provisioned with. Fails closed on an
 * unrecognised value: a typo must not silently fall back to public-IP exposure.
 */
export function resolveManagedNodeTransport(
  env: TunnelTransportEnv,
  node: ManagedNodeTransportInput
): NodeTransport | null {
  const configured = env.VM_AGENT_TRANSPORT?.trim() ?? '';
  if (configured === '' || configured === 'vm-public-dns') return null;
  if (configured !== 'cloudflare-tunnel') {
    throw new Error(`Unsupported VM_AGENT_TRANSPORT ${JSON.stringify(configured)}`);
  }
  if (node.isDeploymentNode || node.runtime !== 'vm' || node.nodeClass !== 'managed') return null;
  return 'cloudflare-tunnel';
}

export function resolveVmAgentTunnelPort(env: TunnelTransportEnv): string {
  const port = env.VM_AGENT_TUNNEL_PORT?.trim() || DEFAULT_VM_AGENT_TUNNEL_PORT;
  const value = Number(port);
  if (!/^\d+$/.test(port) || value < 1 || value > 65535) {
    throw new Error(`VM_AGENT_TUNNEL_PORT must be numeric 1-65535 (got ${JSON.stringify(port)})`);
  }
  return port;
}

/**
 * Deterministic per-incarnation tunnel name. The incarnation UUID is server-generated and
 * random, so the name is both the idempotency key for a lost create response and an
 * ownership proof when re-reading Cloudflare's inventory.
 */
export function buildNodeTunnelName(nodeId: string, runtimeIncarnationId: string): string {
  const incarnation = runtimeIncarnationId.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  if (!incarnation) throw new Error('Tunnel name requires a runtime incarnation');
  return `sam-${nodeId.toLowerCase()}-${incarnation}`;
}

/** The existing node backend hostname; tunnels reuse it rather than minting new hostnames. */
export function nodeTunnelHostname(nodeId: string, env: Pick<Env, 'BASE_DOMAIN'>): string {
  return getNodeBackendHostname(nodeId, env.BASE_DOMAIN);
}

/** Remote ingress: only the node hostname reaches the tunnel listener; everything else 404s. */
export function buildNodeTunnelIngress(hostname: string, tunnelPort: string) {
  return [{ hostname, service: `http://127.0.0.1:${tunnelPort}` }, { service: 'http_status:404' }];
}
