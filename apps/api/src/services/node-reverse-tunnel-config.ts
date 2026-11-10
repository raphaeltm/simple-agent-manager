/**
 * Configuration and credential primitives for the reverse-tunnel (frp) node transport.
 *
 * Topology (self-hosted control plane, VM_AGENT_TRANSPORT='reverse-tunnel'): frps runs on the
 * control-plane box bound to loopback; each node's frpc dials `wss://api.{BASE_DOMAIN}/~!frp`
 * and binds ONE tcp proxy at `127.0.0.1:{leasePort}` on the box. The Worker and Caddy reach the
 * node agent at that address. Everything here is bootstrap configuration that must agree with
 * the box's frps.toml and Caddy fragments (deploy/selfhost/), so it is not a runtime tunable.
 */
import type { Env } from '../env';

/**
 * Address frps binds per-node proxies on (frps `proxyBindAddr`); the Worker and Caddy share it.
 * Fixed, not configurable: anything but loopback would expose node agents beyond the box.
 */
export const REVERSE_TUNNEL_UPSTREAM_HOST = '127.0.0.1';
/** Default leased port range; must equal frps `allowPorts` in deploy/selfhost/frps/frps.toml. */
export const DEFAULT_REVERSE_TUNNEL_PORT_RANGE_START = 20000;
export const DEFAULT_REVERSE_TUNNEL_PORT_RANGE_END = 29999;
/**
 * Upper bound on the range size. Allocation enumerates the range inside one SQL statement (a
 * recursive CTE with one indexed lookup per candidate), so the worst case is one statement
 * walking 20k rows per node provisioning: milliseconds on SQLite, well inside D1's statement
 * limits, and provisioning is rare. Without the bound an accidental `1-65535` would walk 64k.
 */
export const MAX_REVERSE_TUNNEL_PORT_RANGE_SIZE = 20000;
/** The gateway secret is a random token shared with frps and Caddy; refuse anything guessable. */
export const MIN_REVERSE_TUNNEL_GATEWAY_SECRET_LENGTH = 32;

const CREDENTIAL_LABEL = 'sam-reverse-tunnel-credential:v1';

export type ReverseTunnelEnv = Pick<
  Env,
  | 'REVERSE_TUNNEL_GATEWAY_SECRET'
  | 'REVERSE_TUNNEL_PORT_RANGE_START'
  | 'REVERSE_TUNNEL_PORT_RANGE_END'
>;

export interface ReverseTunnelPortRange {
  start: number;
  end: number;
}

function parsePort(name: string, raw: string | undefined, fallback: number): number {
  const value = raw?.trim() ?? '';
  if (value === '') return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) {
    throw new Error(`${name} must be numeric 1024-65535 (got ${JSON.stringify(value)})`);
  }
  return Number(value);
}

/** The leased port range. Fails closed on a malformed or oversized range. */
export function resolveReverseTunnelPortRange(env: ReverseTunnelEnv): ReverseTunnelPortRange {
  const start = parsePort(
    'REVERSE_TUNNEL_PORT_RANGE_START',
    env.REVERSE_TUNNEL_PORT_RANGE_START,
    DEFAULT_REVERSE_TUNNEL_PORT_RANGE_START
  );
  const end = parsePort(
    'REVERSE_TUNNEL_PORT_RANGE_END',
    env.REVERSE_TUNNEL_PORT_RANGE_END,
    DEFAULT_REVERSE_TUNNEL_PORT_RANGE_END
  );
  if (end < start) {
    throw new Error(
      'REVERSE_TUNNEL_PORT_RANGE_END must not be below REVERSE_TUNNEL_PORT_RANGE_START'
    );
  }
  if (end - start + 1 > MAX_REVERSE_TUNNEL_PORT_RANGE_SIZE) {
    throw new Error(
      `Reverse-tunnel port range may hold at most ${MAX_REVERSE_TUNNEL_PORT_RANGE_SIZE} ports`
    );
  }
  return { start, end };
}

/** The configured gateway secret, or null when absent/too short (callers fail closed). */
export function getReverseTunnelGatewaySecret(env: ReverseTunnelEnv): string | null {
  const secret = env.REVERSE_TUNNEL_GATEWAY_SECRET?.trim() ?? '';
  return secret.length >= MIN_REVERSE_TUNNEL_GATEWAY_SECRET_LENGTH ? secret : null;
}

/** `http://127.0.0.1:{port}`: where the Worker and Caddy reach a reverse-tunnel node's agent. */
export function reverseTunnelUpstreamOrigin(port: number): string {
  return `http://${REVERSE_TUNNEL_UPSTREAM_HOST}:${port}`;
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ReverseTunnelCredentialIdentity {
  leaseId: string;
  nodeId: string;
  runtimeIncarnationId: string;
}

/**
 * The node's frp credential: HMAC-SHA256 of the lease identity under the Worker-only
 * ENCRYPTION_KEY, with a purpose label for domain separation. Deterministic so a durable
 * provisioning resume can re-render the same cloud-init without storing the plaintext; the
 * lease row stores only its SHA-256. SECRET: cloud-init only, never logged or persisted.
 */
export async function deriveReverseTunnelCredential(
  env: Pick<Env, 'ENCRYPTION_KEY'>,
  identity: ReverseTunnelCredentialIdentity
): Promise<string> {
  if (!env.ENCRYPTION_KEY)
    throw new Error('ENCRYPTION_KEY is required for reverse-tunnel credentials');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.ENCRYPTION_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const message = `${CREDENTIAL_LABEL}\n${identity.leaseId}\n${identity.nodeId}\n${identity.runtimeIncarnationId}`;
  return base64Url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

/** SHA-256 hex of a presented or minted credential; the only form ever stored. */
export async function hashReverseTunnelCredential(credential: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential)));
}
