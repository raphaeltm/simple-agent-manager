const REVERSE_TUNNEL_HEARTBEAT_INTERVAL_SECONDS = '30';
const REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS = '90';

import { constantTimeEqual } from '../../lib/constant-time';
import type { ReverseTunnelEnv as Env } from './env';

export const REVERSE_TUNNEL_UPSTREAM_HOST = '127.0.0.1';
export const DEFAULT_REVERSE_TUNNEL_PORT_RANGE_START = 20000;
export const DEFAULT_REVERSE_TUNNEL_PORT_RANGE_END = 29999;
export const MAX_REVERSE_TUNNEL_PORT_RANGE_SIZE = 20000;
export const MIN_REVERSE_TUNNEL_GATEWAY_SECRET_LENGTH = 32;

export const DEFAULT_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS = Number(
  REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS
);
export const MIN_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS =
  2 * Number(REVERSE_TUNNEL_HEARTBEAT_INTERVAL_SECONDS);
export const MAX_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS = 3600;
export const REVERSE_TUNNEL_PORT_REUSE_HEARTBEAT_MULTIPLE = 2;
export const DEFAULT_REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS =
  REVERSE_TUNNEL_PORT_REUSE_HEARTBEAT_MULTIPLE * DEFAULT_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS;
export const MAX_REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS = 86_400;

const CREDENTIAL_LABEL = 'sam-reverse-tunnel-credential:v1';

export type ReverseTunnelEnv = Pick<
  Env,
  | 'REVERSE_TUNNEL_GATEWAY_SECRET'
  | 'REVERSE_TUNNEL_GATEWAY_SECRET_ALTERNATE'
  | 'REVERSE_TUNNEL_PORT_RANGE_START'
  | 'REVERSE_TUNNEL_PORT_RANGE_END'
  | 'REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS'
  | 'REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS'
>;

export type ReverseTunnelRangeEnv = Pick<
  Env,
  'REVERSE_TUNNEL_PORT_RANGE_START' | 'REVERSE_TUNNEL_PORT_RANGE_END'
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

export function resolveReverseTunnelPortRange(env: ReverseTunnelRangeEnv): ReverseTunnelPortRange {
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

function parseSeconds(
  name: string,
  raw: string | undefined,
  fallback: number,
  bounds: { min: number; max: number }
): number {
  const value = raw?.trim() ?? '';
  if (value === '') return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || parsed < bounds.min || parsed > bounds.max) {
    throw new Error(
      `${name} must be whole seconds ${bounds.min}-${bounds.max} (got ${JSON.stringify(value)})`
    );
  }
  return parsed;
}

export function resolveReverseTunnelHeartbeatTimeoutSeconds(
  env: Pick<Env, 'REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS'>
): number {
  return parseSeconds(
    'REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS',
    env.REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS,
    DEFAULT_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS,
    {
      min: MIN_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS,
      max: MAX_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS,
    }
  );
}

export function resolveReverseTunnelPortReuseMinAgeSeconds(
  env: Pick<
    Env,
    'REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS' | 'REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS'
  >
): number {
  const floor =
    REVERSE_TUNNEL_PORT_REUSE_HEARTBEAT_MULTIPLE * resolveReverseTunnelHeartbeatTimeoutSeconds(env);
  const configured = parseSeconds(
    'REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS',
    env.REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS,
    Math.max(DEFAULT_REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS, floor),
    { min: 0, max: MAX_REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS }
  );
  if (configured < floor) {
    throw new Error(
      `REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS must be at least ${floor} ` +
        `(${REVERSE_TUNNEL_PORT_REUSE_HEARTBEAT_MULTIPLE} x the frps heartbeat timeout)`
    );
  }
  return configured;
}

export function assertReverseTunnelUpstreamPort(env: ReverseTunnelRangeEnv, port: number): void {
  const range = resolveReverseTunnelPortRange(env);
  if (!Number.isInteger(port) || port < range.start || port > range.end) {
    throw new Error(
      `Reverse-tunnel lease port ${String(port)} is outside the configured range ${range.start}-${range.end}`
    );
  }
}

export function getReverseTunnelGatewaySecret(env: ReverseTunnelEnv): string | null {
  const secret = env.REVERSE_TUNNEL_GATEWAY_SECRET?.trim() ?? '';
  return secret.length >= MIN_REVERSE_TUNNEL_GATEWAY_SECRET_LENGTH ? secret : null;
}

export function isAcceptedGatewaySecret(env: ReverseTunnelEnv, presented: string): boolean {
  const primary = getReverseTunnelGatewaySecret(env);
  if (!primary) return false;
  const alternate = env.REVERSE_TUNNEL_GATEWAY_SECRET_ALTERNATE?.trim() ?? '';
  const primaryMatch = constantTimeEqual(presented, primary);
  const alternateMatch =
    alternate.length >= MIN_REVERSE_TUNNEL_GATEWAY_SECRET_LENGTH &&
    constantTimeEqual(presented, alternate);
  return primaryMatch || alternateMatch;
}

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

/** HKDF creates separate HMAC keys for credentials and frps control-session identities. */
async function signIdentity(
  env: Pick<Env, 'ENCRYPTION_KEY'>,
  purpose: string,
  identity: ReverseTunnelCredentialIdentity
): Promise<ArrayBuffer> {
  if (!env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY is required for reverse-tunnel credentials');
  for (const value of Object.values(identity)) {
    if (!value || value.length > 256) throw new Error('Reverse-tunnel identity is required and bounded');
  }
  const encoder = new TextEncoder();
  const root = await crypto.subtle.importKey('raw', encoder.encode(env.ENCRYPTION_KEY), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('sam:reverse-tunnel:v1'), info: encoder.encode(purpose) },
    root, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']
  );
  return crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify([
    identity.leaseId, identity.nodeId, identity.runtimeIncarnationId,
  ])));
}
export async function deriveReverseTunnelCredential(
  env: Pick<Env, 'ENCRYPTION_KEY'>, identity: ReverseTunnelCredentialIdentity
): Promise<string> {
  return base64Url(await signIdentity(env, CREDENTIAL_LABEL, identity));
}
/** frps replaces the previous control before activating another with this same server-chosen id. */
export async function deriveReverseTunnelRunId(
  env: Pick<Env, 'ENCRYPTION_KEY'>, identity: ReverseTunnelCredentialIdentity
): Promise<string> {
  return hex(await signIdentity(env, 'sam-reverse-tunnel-control:v1', identity)).slice(0, 32);
}

export async function hashReverseTunnelCredential(credential: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential)));
}
