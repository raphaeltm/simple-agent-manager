/**
 * Deploy payload signing service.
 *
 * Signs deployment payloads with a dedicated Ed25519 deploy-signing key. This
 * is NOT the callback JWT key — it is a separate key pair used exclusively for
 * node-side deployment payload integrity verification.
 */
import type { Env } from '../env';

interface SignablePayload {
  environmentId: string;
  nodeId: string;
  seq: number;
  expiresAt: number;
  composeYaml: string;
  routes?: unknown;
  artifacts?: unknown;
  volumeMounts?: unknown;
  interpolationEnv?: Record<string, string>;
}

interface RouteConfigSignablePayload {
  environmentId: string;
  nodeId: string;
  currentSeq: number;
  routingRevision: number;
  expiresAt: number;
  routes?: unknown;
}

const ED25519_PKCS8_SEED_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

async function buildSignableBytes(p: SignablePayload): Promise<Uint8Array> {
  const composeHash = await sha256Hex(new TextEncoder().encode(p.composeYaml));
  const routesHash = await sha256Hex(encodeJson(p.routes ?? []));
  const interpolationEnvHash = await hashInterpolationEnv(p.interpolationEnv);
  const artifactsHash = await sha256Hex(encodeJson(p.artifacts ?? []));
  const volumeMountsHash = await sha256Hex(encodeJson(p.volumeMounts ?? []));

  const canonical = JSON.stringify({
    environmentId: p.environmentId,
    nodeId: p.nodeId,
    seq: p.seq,
    expiresAt: p.expiresAt,
    composeHash,
    routesHash,
    interpolationEnvHash,
    artifactsHash,
    volumeMountsHash,
  });

  return new TextEncoder().encode(canonical);
}

async function buildRouteConfigSignableBytes(p: RouteConfigSignablePayload): Promise<Uint8Array> {
  const routesHash = await sha256Hex(encodeJson(p.routes ?? []));
  const canonical = JSON.stringify({
    environmentId: p.environmentId,
    nodeId: p.nodeId,
    currentSeq: p.currentSeq,
    routingRevision: p.routingRevision,
    expiresAt: p.expiresAt,
    routesHash,
  });
  return new TextEncoder().encode(canonical);
}

export async function hashInterpolationEnv(
  env: Record<string, string> | undefined
): Promise<string> {
  const entries = Object.entries(env ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return sha256Hex(encodeJson(entries));
}

async function importDeploySigningKey(
  env: Pick<Env, 'DEPLOY_SIGNING_PRIVATE_KEY'>
): Promise<CryptoKey> {
  const privateKeyB64 = env.DEPLOY_SIGNING_PRIVATE_KEY;
  if (!privateKeyB64) {
    throw new Error('DEPLOY_SIGNING_PRIVATE_KEY is not configured');
  }

  const privateKeyBytes = Uint8Array.from(atob(privateKeyB64), (c) => c.charCodeAt(0));
  if (privateKeyBytes.length !== 32 && privateKeyBytes.length !== 64) {
    throw new Error(
      `DEPLOY_SIGNING_PRIVATE_KEY has invalid length: got ${privateKeyBytes.length} bytes, expected 32 (seed) or 64 (seed+pubkey)`
    );
  }

  const seed = privateKeyBytes.length === 64 ? privateKeyBytes.slice(0, 32) : privateKeyBytes;
  const pkcs8Key = new Uint8Array(ED25519_PKCS8_SEED_PREFIX.length + seed.length);
  pkcs8Key.set(ED25519_PKCS8_SEED_PREFIX);
  pkcs8Key.set(seed, ED25519_PKCS8_SEED_PREFIX.length);

  return crypto.subtle.importKey('pkcs8', pkcs8Key, { name: 'Ed25519' }, false, ['sign']);
}

async function signCanonicalBytes(
  message: Uint8Array,
  env: Pick<Env, 'DEPLOY_SIGNING_PRIVATE_KEY'>
): Promise<string> {
  const key = await importDeploySigningKey(env);
  const signatureBuffer = await crypto.subtle.sign('Ed25519', key, message);
  return btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
}

/** Sign a full application release apply payload. */
export async function signDeployPayload(
  payload: SignablePayload,
  env: Pick<Env, 'DEPLOY_SIGNING_PRIVATE_KEY'>
): Promise<string> {
  return signCanonicalBytes(await buildSignableBytes(payload), env);
}

/** Sign a route-only Caddy configuration payload. */
export async function signRouteConfigPayload(
  payload: RouteConfigSignablePayload,
  env: Pick<Env, 'DEPLOY_SIGNING_PRIVATE_KEY'>
): Promise<string> {
  return signCanonicalBytes(await buildRouteConfigSignableBytes(payload), env);
}

/** Get the deploy signing public key (base64-encoded) for provisioning or heartbeat refresh. */
export function getDeploySigningPublicKey(
  env: Pick<Env, 'DEPLOY_SIGNING_PUBLIC_KEY'>
): string | null {
  return env.DEPLOY_SIGNING_PUBLIC_KEY || null;
}
