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
import { getNodeBackendHostname } from './dns-core';

/** Worker configuration is canonical; no separate pre-integration environment contract. */
export type TunnelEnv = Env;
type TunnelTransportEnv = Pick<Env, 'VM_AGENT_TRANSPORT' | 'VM_AGENT_TUNNEL_PORT'>;

export const DEFAULT_CF_TUNNEL_API_IDEMPOTENT_ATTEMPTS = 3;
export const DEFAULT_CF_TUNNEL_API_RETRY_DELAY_MS = 250;
export const DEFAULT_NODE_TUNNEL_CLEANUP_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_NODE_TUNNEL_CLEANUP_BATCH_SIZE = 10;
export const DEFAULT_NODE_TUNNEL_CLEANUP_BACKOFF_BASE_MS = 60_000;
export const DEFAULT_NODE_TUNNEL_CLEANUP_BACKOFF_MAX_MS = 3_600_000;
export const DEFAULT_NODE_TUNNEL_CLEANUP_STUCK_ATTEMPTS = 6;

type TunnelApiConfigEnv = Pick<
  Env,
  'CF_TUNNEL_API_IDEMPOTENT_ATTEMPTS' | 'CF_TUNNEL_API_RETRY_DELAY_MS'
>;
type TunnelCleanupConfigEnv = Pick<
  Env,
  | 'NODE_TUNNEL_CLEANUP_REQUEST_TIMEOUT_MS'
  | 'NODE_TUNNEL_CLEANUP_BATCH_SIZE'
  | 'NODE_TUNNEL_CLEANUP_BACKOFF_BASE_MS'
  | 'NODE_TUNNEL_CLEANUP_BACKOFF_MAX_MS'
  | 'NODE_TUNNEL_CLEANUP_STUCK_ATTEMPTS'
>;
type TunnelBootConfigEnv = Pick<
  Env,
  | 'CLOUDFLARED_VERSION'
  | 'VM_AGENT_TUNNEL_LISTENER_WAIT_SECONDS'
  | 'VM_AGENT_TUNNEL_PROBE_TIMEOUT_SECONDS'
  | 'VM_AGENT_TUNNEL_PROBE_INTERVAL_SECONDS'
  | 'VM_AGENT_TUNNEL_RESTART_SECONDS'
>;

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function resolveNodeTunnelApiConfig(env: TunnelApiConfigEnv) {
  return {
    attempts: positiveInteger(
      env.CF_TUNNEL_API_IDEMPOTENT_ATTEMPTS,
      DEFAULT_CF_TUNNEL_API_IDEMPOTENT_ATTEMPTS
    ),
    retryDelayMs: positiveInteger(
      env.CF_TUNNEL_API_RETRY_DELAY_MS,
      DEFAULT_CF_TUNNEL_API_RETRY_DELAY_MS
    ),
  };
}

export function resolveNodeTunnelCleanupConfig(env: TunnelCleanupConfigEnv) {
  return {
    requestTimeoutMs: positiveInteger(
      env.NODE_TUNNEL_CLEANUP_REQUEST_TIMEOUT_MS,
      DEFAULT_NODE_TUNNEL_CLEANUP_REQUEST_TIMEOUT_MS
    ),
    batchSize: positiveInteger(
      env.NODE_TUNNEL_CLEANUP_BATCH_SIZE,
      DEFAULT_NODE_TUNNEL_CLEANUP_BATCH_SIZE
    ),
    backoffBaseMs: positiveInteger(
      env.NODE_TUNNEL_CLEANUP_BACKOFF_BASE_MS,
      DEFAULT_NODE_TUNNEL_CLEANUP_BACKOFF_BASE_MS
    ),
    backoffMaxMs: positiveInteger(
      env.NODE_TUNNEL_CLEANUP_BACKOFF_MAX_MS,
      DEFAULT_NODE_TUNNEL_CLEANUP_BACKOFF_MAX_MS
    ),
    stuckAttempts: positiveInteger(
      env.NODE_TUNNEL_CLEANUP_STUCK_ATTEMPTS,
      DEFAULT_NODE_TUNNEL_CLEANUP_STUCK_ATTEMPTS
    ),
  };
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
