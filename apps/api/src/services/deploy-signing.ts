/**
 * Deploy payload signing service.
 *
 * Signs apply payloads with a dedicated Ed25519 deploy-signing key.
 * This is NOT the callback JWT key — it's a separate key pair used
 * exclusively for deployment payload integrity verification.
 *
 * The private key is stored as a Worker secret (DEPLOY_SIGNING_PRIVATE_KEY,
 * base64-encoded Ed25519 seed). The corresponding public key is delivered
 * to deployment nodes at provision time and refreshable via heartbeat.
 */
import type { Env } from '../env';

/**
 * Payload fields that are signed (mirrors Go-side SignablePayload).
 */
interface SignablePayload {
  environmentId: string;
  nodeId: string;
  seq: number;
  expiresAt: number;
  composeYaml: string;
  routes?: unknown;
}

const ED25519_PKCS8_SEED_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/**
 * Build the canonical bytes to sign, matching the Go-side buildSignableBytes().
 *
 * Format: JSON of { environmentId, nodeId, seq, expiresAt, composeHash, routesHash }
 * where composeHash is SHA-256 of the Compose YAML and routesHash is SHA-256
 * of the canonical route target JSON.
 */
async function buildSignableBytes(p: SignablePayload): Promise<Uint8Array> {
  const composeBytes = new TextEncoder().encode(p.composeYaml);
  const hashBuffer = await crypto.subtle.digest('SHA-256', composeBytes);
  const hashArray = new Uint8Array(hashBuffer);
  const composeHash = Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const routesBytes = new TextEncoder().encode(JSON.stringify(p.routes ?? []));
  const routesHashBuffer = await crypto.subtle.digest('SHA-256', routesBytes);
  const routesHashArray = new Uint8Array(routesHashBuffer);
  const routesHash = Array.from(routesHashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const canonical = JSON.stringify({
    environmentId: p.environmentId,
    nodeId: p.nodeId,
    seq: p.seq,
    expiresAt: p.expiresAt,
    composeHash,
    routesHash,
  });

  return new TextEncoder().encode(canonical);
}

/**
 * Sign a deploy payload using the Ed25519 private key from Worker secrets.
 *
 * Returns the base64-encoded signature string.
 */
export async function signDeployPayload(
  payload: SignablePayload,
  env: Pick<Env, 'DEPLOY_SIGNING_PRIVATE_KEY'>,
): Promise<string> {
  const privateKeyB64 = env.DEPLOY_SIGNING_PRIVATE_KEY;
  if (!privateKeyB64) {
    throw new Error('DEPLOY_SIGNING_PRIVATE_KEY is not configured');
  }

  // Decode the base64-encoded Ed25519 private key.
  // Accepts either 32-byte seed or 64-byte Go format (seed + public key).
  const privateKeyBytes = Uint8Array.from(atob(privateKeyB64), (c) => c.charCodeAt(0));

  if (privateKeyBytes.length !== 32 && privateKeyBytes.length !== 64) {
    throw new Error(
      `DEPLOY_SIGNING_PRIVATE_KEY has invalid length: got ${privateKeyBytes.length} bytes, expected 32 (seed) or 64 (seed+pubkey)`,
    );
  }

  // WebCrypto imports Ed25519 private keys as PKCS#8. The DER wrapper carries
  // the raw 32-byte seed without adding node-side credential material.
  const seed = privateKeyBytes.length === 64 ? privateKeyBytes.slice(0, 32) : privateKeyBytes;
  const pkcs8Key = new Uint8Array(ED25519_PKCS8_SEED_PREFIX.length + seed.length);
  pkcs8Key.set(ED25519_PKCS8_SEED_PREFIX);
  pkcs8Key.set(seed, ED25519_PKCS8_SEED_PREFIX.length);

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8Key,
    { name: 'Ed25519' },
    false,
    ['sign'],
  );

  const message = await buildSignableBytes(payload);
  const signatureBuffer = await crypto.subtle.sign('Ed25519', key, message);

  // Base64 encode the signature
  return btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
}

/**
 * Get the deploy signing public key (base64-encoded) for provisioning or heartbeat refresh.
 */
export function getDeploySigningPublicKey(
  env: Pick<Env, 'DEPLOY_SIGNING_PUBLIC_KEY'>,
): string | null {
  return env.DEPLOY_SIGNING_PUBLIC_KEY || null;
}
