/**
 * Transport selection and tunnel configuration for managed workspace VM nodes.
 *
 * `VM_AGENT_TRANSPORT='cloudflare-tunnel'` opts NEW managed workspace VM nodes into an
 * outbound-only Cloudflare named tunnel. An unset transport keeps legacy public-IP
 * transport unchanged; unsupported values fail provisioning. Deployment-role nodes and Instant (cf-container) runtimes are
 * deliberately excluded: deployment nodes serve public app routes on their own IP, and a
 * container runtime has no VM to run cloudflared on.
 */
import {
  DEFAULT_CLOUDFLARE_TUNNEL_PORT,
  DEFAULT_CLOUDFLARED_VERSION,
  DEFAULT_TUNNEL_CONNECTOR_RESTART_SECONDS,
  DEFAULT_TUNNEL_LISTENER_PROBE_INTERVAL_SECONDS,
  DEFAULT_TUNNEL_LISTENER_PROBE_TIMEOUT_SECONDS,
  DEFAULT_TUNNEL_LISTENER_WAIT_SECONDS,
} from '@simple-agent-manager/cloud-init';
import type { NodeTransport } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { resolveAdminSetting } from './admin-settings';
import {
  NODE_TUNNEL_RUNTIME_DEFAULTS,
  type NodeTunnelSettingName,
} from './admin-settings-node-tunnel-definitions';
import { getNodeBackendHostname } from './dns-core';

/** Worker configuration is canonical; no separate pre-integration environment contract. */
export type TunnelEnv = Env;
type TunnelTransportEnv = Pick<Env, 'VM_AGENT_TRANSPORT' | 'VM_AGENT_TUNNEL_PORT'>;

type TunnelBootConfigEnv = Pick<
  Env,
  | 'CLOUDFLARED_VERSION'
  | 'VM_AGENT_TUNNEL_LISTENER_WAIT_SECONDS'
  | 'VM_AGENT_TUNNEL_PROBE_TIMEOUT_SECONDS'
  | 'VM_AGENT_TUNNEL_PROBE_INTERVAL_SECONDS'
  | 'VM_AGENT_TUNNEL_RESTART_SECONDS'
>;

async function runtimeValue(
  env: Env,
  key: keyof typeof NODE_TUNNEL_RUNTIME_DEFAULTS
): Promise<number> {
  const name: NodeTunnelSettingName = `vmTunnels.${key}`;
  const value = await resolveAdminSetting(env, name);
  return typeof value === 'number' ? value : NODE_TUNNEL_RUNTIME_DEFAULTS[key];
}

export async function resolveNodeTunnelApiConfig(env: Env) {
  const [attempts, retryDelayMs] = await Promise.all([
    runtimeValue(env, 'apiAttempts'),
    runtimeValue(env, 'apiRetryDelayMs'),
  ]);
  return { attempts, retryDelayMs };
}

export async function resolveNodeTunnelCleanupConfig(env: Env) {
  const [requestTimeoutMs, batchSize, backoffBaseMs, backoffMaxMs, stuckAttempts] =
    await Promise.all([
      runtimeValue(env, 'cleanupRequestTimeoutMs'),
      runtimeValue(env, 'cleanupBatchSize'),
      runtimeValue(env, 'cleanupBackoffBaseMs'),
      runtimeValue(env, 'cleanupBackoffMaxMs'),
      runtimeValue(env, 'cleanupStuckAttempts'),
    ]);
  return { requestTimeoutMs, batchSize, backoffBaseMs, backoffMaxMs, stuckAttempts };
}

/** Cloud-init validates the supported release and timing bounds before rendering. */
export function nodeTunnelBootVariables(env: TunnelBootConfigEnv) {
  return {
    cloudflaredVersion: env.CLOUDFLARED_VERSION?.trim() || DEFAULT_CLOUDFLARED_VERSION,
    tunnelListenerWaitSeconds:
      env.VM_AGENT_TUNNEL_LISTENER_WAIT_SECONDS?.trim() || DEFAULT_TUNNEL_LISTENER_WAIT_SECONDS,
    tunnelListenerProbeTimeoutSeconds:
      env.VM_AGENT_TUNNEL_PROBE_TIMEOUT_SECONDS?.trim() ||
      DEFAULT_TUNNEL_LISTENER_PROBE_TIMEOUT_SECONDS,
    tunnelListenerProbeIntervalSeconds:
      env.VM_AGENT_TUNNEL_PROBE_INTERVAL_SECONDS?.trim() ||
      DEFAULT_TUNNEL_LISTENER_PROBE_INTERVAL_SECONDS,
    tunnelConnectorRestartSeconds:
      env.VM_AGENT_TUNNEL_RESTART_SECONDS?.trim() || DEFAULT_TUNNEL_CONNECTOR_RESTART_SECONDS,
  };
}

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
  const port = env.VM_AGENT_TUNNEL_PORT?.trim() || DEFAULT_CLOUDFLARE_TUNNEL_PORT;
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
