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

import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as tls from "@pulumi/tls";

/**
 * Encryption key for user credentials stored in D1.
 * 32 bytes (256 bits) for AES-256 encryption.
 * Output is base64-encoded.
 */
const encryptionKeyResource = new random.RandomId(
  "encryption-key",
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
  "jwt-signing-key",
  {
    algorithm: "RSA",
    rsaBits: 2048,
  },
  { protect: true }
);

// Export as secret outputs (Pulumi redacts secrets in logs and state output)
export const encryptionKey = pulumi.secret(encryptionKeyResource.b64Std);
export const jwtPrivateKey = pulumi.secret(jwtKeyResource.privateKeyPemPkcs8);
export const jwtPublicKey = pulumi.secret(jwtKeyResource.publicKeyPem);
