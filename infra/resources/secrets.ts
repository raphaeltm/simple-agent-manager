/**
 * Security Key Resources
 *
 * These Pulumi resources generate and persist cryptographic keys in Pulumi state.
 * The state is stored encrypted in R2 (using PULUMI_CONFIG_PASSPHRASE), ensuring
 * keys persist automatically across deployments without manual intervention.
 *
 * Key Persistence:
 * - Keys are created once and reused forever (idempotent)
 * - Pulumi state in R2 is encrypted at rest
 * - `protect: true` prevents accidental deletion
 *
 * Migration from GitHub Secrets:
 * - If existing keys are stored in GitHub Secrets, they take precedence
 * - To migrate to Pulumi-managed keys, delete the GitHub secrets
 * - Note: Migration creates NEW keys, invalidating old encrypted data
 */

import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';
import * as tls from '@pulumi/tls';
import * as crypto from 'node:crypto';

const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PUBLIC_KEY_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function deriveDeploySigningPublicKey(privateKeyB64: string): string {
  const privateKeyBytes = Buffer.from(privateKeyB64, 'base64');
  if (privateKeyBytes.length !== 32 && privateKeyBytes.length !== 64) {
    throw new Error(
      `deploy signing private key has invalid length: got ${privateKeyBytes.length} bytes, expected 32 (seed) or 64 (seed+pubkey)`
    );
  }

  const seed = privateKeyBytes.subarray(0, 32);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicDer = crypto.createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki',
  }) as Buffer;

  if (
    !publicDer
      .subarray(0, ED25519_SPKI_PUBLIC_KEY_PREFIX.length)
      .equals(ED25519_SPKI_PUBLIC_KEY_PREFIX)
  ) {
    throw new Error('derived deploy signing public key has unexpected Ed25519 SPKI prefix');
  }

  return publicDer.subarray(ED25519_SPKI_PUBLIC_KEY_PREFIX.length).toString('base64');
}

/**
 * Encryption key for user credentials stored in D1.
 * 32 bytes (256 bits) for AES-256 encryption.
 * Output is base64-encoded.
 */
const encryptionKeyResource = new random.RandomId(
  'encryption-key',
  {
    byteLength: 32,
  },
  { protect: true }
);

/**
 * RSA-2048 key pair for JWT signing and verification.
 * Used by the API to issue and validate authentication tokens.
 */
const jwtKeyResource = new tls.PrivateKey(
  'jwt-signing-key',
  {
    algorithm: 'RSA',
    rsaBits: 2048,
  },
  { protect: true }
);

/**
 * HMAC-SHA256 secret for trial onboarding claim/fingerprint cookies.
 * 32 bytes (256 bits), base64-encoded.
 *
 * Used by `apps/api/src/services/trial/cookies.ts` to sign and verify
 * `sam_trial_fingerprint` (7d) and `sam_trial_claim` (48h) cookies.
 * Rotating this invalidates all in-flight trials.
 */
const trialClaimTokenResource = new random.RandomId(
  'trial-claim-token-secret',
  {
    byteLength: 32,
  },
  { protect: true }
);

/**
 * Ed25519 seed for signing deployment apply payloads.
 * 32 bytes (256 bits), base64-encoded.
 *
 * The VM agent verifier consumes the derived raw 32-byte public key, also
 * base64-encoded. Both values persist in Pulumi state so fresh deployments do
 * not need manual GitHub Environment secrets for platform-owned signing keys.
 */
const deploySigningPrivateKeyResource = new random.RandomId(
  'deploy-signing-private-key',
  {
    byteLength: 32,
  },
  { protect: true }
);

const deploySigningPrivateKeySeed = pulumi.secret(deploySigningPrivateKeyResource.b64Std);

// Export as secret outputs (Pulumi redacts secrets in logs and state output)
export const encryptionKey = pulumi.secret(encryptionKeyResource.b64Std);
export const jwtPrivateKey = pulumi.secret(jwtKeyResource.privateKeyPemPkcs8);
export const jwtPublicKey = pulumi.secret(jwtKeyResource.publicKeyPem);
export const trialClaimTokenSecret = pulumi.secret(trialClaimTokenResource.b64Std);
export const deploySigningPrivateKey = deploySigningPrivateKeySeed;
export const deploySigningPublicKey = deploySigningPrivateKeySeed.apply(
  deriveDeploySigningPublicKey
);
