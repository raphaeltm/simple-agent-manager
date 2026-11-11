/**
 * Transport selection and tunnel configuration for managed VM nodes.
 *
 * `VM_AGENT_TRANSPORT='cloudflare-tunnel'` opts NEW managed VM nodes, workspace and deployment
 * role alike, into an outbound-only Cloudflare named tunnel for the VM agent's control channel
 * (`{nodeId}.vm.{BASE_DOMAIN}`). `VM_AGENT_TRANSPORT='reverse-tunnel'` (self-hosted control
 * plane) gives NEW managed workspace VM nodes a pinned frpc that dials the control-plane box
 * instead (services/node-reverse-tunnel-*.ts); deployment nodes stay on public-IP transport
 * there, because the reverse-tunnel path has only been built and verified for workspace nodes.
 * An unset transport keeps legacy public-IP transport unchanged; unsupported values fail
 * provisioning. Instant (cf-container) runtimes are excluded: a container runtime has no VM to
 * run a tunnel client on.
 *
 * Deployment nodes keep their public app ingress: app routes stay grey-cloud A records to the
 * node IP, with Caddy terminating TLS by ACME (services/dns-app-routes.ts). Routing app
 * traffic through the tunnel would need edge certificates for nested `*.apps.` hostnames
 * (Advanced Certificate Manager) and Cloudflare for SaaS for user custom domains; see
 * tasks/archive/2026-11-10-tunnel-transport-hardening.md.
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
  const [
    requestTimeoutMs,
    batchSize,
    sweepBudgetMs,
    backoffBaseMs,
    backoffMaxMs,
    stuckAttempts,
    pendingCreateSettleMs,
  ] = await Promise.all([
    runtimeValue(env, 'cleanupRequestTimeoutMs'),
    runtimeValue(env, 'cleanupBatchSize'),
    runtimeValue(env, 'cleanupSweepBudgetMs'),
    runtimeValue(env, 'cleanupBackoffBaseMs'),
    runtimeValue(env, 'cleanupBackoffMaxMs'),
    runtimeValue(env, 'cleanupStuckAttempts'),
    runtimeValue(env, 'pendingCreateSettleMs'),
  ]);
  return {
    requestTimeoutMs,
    batchSize,
    sweepBudgetMs,
    backoffBaseMs,
    backoffMaxMs,
    stuckAttempts,
    pendingCreateSettleMs,
  };
}

/** Extra durable-attempt time for tunnel setup (see `NodeLifecycleProvisioning.run`). */
export async function resolveNodeTunnelProvisioningBudgetMs(env: Env): Promise<number> {
  return runtimeValue(env, 'provisioningBudgetMs');
}

/**
 * Tunnel-setup share of a durable provisioning attempt's deadline: zero unless the attempt
 * will provision with tunnel transport, decided exactly as `provisionNode` decides it (a
 * resumed incarnation keeps its recorded transport; a new one reads the installation setting).
 */
export async function durableAttemptTunnelBudgetMs(
  env: Env,
  node: { runtimeIncarnationId: string | null; transport: string | null } & ManagedNodeTransportInput,
  resumingIncarnationId: string
): Promise<number> {
  let transport: string | null;
  try {
    transport =
      node.runtimeIncarnationId === resumingIncarnationId
        ? node.transport
        : resolveManagedNodeTransport(env, node);
  } catch {
    // An invalid transport setting fails inside provisionNode with a recorded error.
    return 0;
  }
  return transport === 'cloudflare-tunnel' ? resolveNodeTunnelProvisioningBudgetMs(env) : 0;
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
  runtime: string;
  nodeClass: string;
  /** The node row's own `node_role` ('workspace' | 'deployment'); required so no caller can omit it. */
  nodeRole: string;
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
  if (configured !== 'cloudflare-tunnel' && configured !== 'reverse-tunnel') {
    throw new Error(`Unsupported VM_AGENT_TRANSPORT ${JSON.stringify(configured)}`);
  }
  if (node.runtime !== 'vm' || node.nodeClass !== 'managed') return null;
  if (configured === 'reverse-tunnel') {
    // Self-hosted box: only workspace nodes have a reverse-tunnel path (lease, frpc
    // cloud-init, node-agent route seam). Deployment nodes keep public-IP transport.
    return node.nodeRole === 'deployment' ? null : 'reverse-tunnel';
  }
  // Deployment nodes are included: the tunnel carries only their agent control channel, and
  // their app routes keep using the public IP.
  return 'cloudflare-tunnel';
}

/**
 * True when this installation provisions reverse-tunnel nodes (a self-hosted box). Used by
 * paths that must not hand a node's URL to another VM: a reverse-tunnel node is reachable only
 * from the box's loopback.
 */
export function isReverseTunnelInstallation(env: Pick<Env, 'VM_AGENT_TRANSPORT'>): boolean {
  return env.VM_AGENT_TRANSPORT?.trim() === 'reverse-tunnel';
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
