/**
 * Secret key resolution helpers.
 *
 * Each helper returns the purpose-specific secret when set, falling back to
 * the shared ENCRYPTION_KEY for backwards compatibility with existing
 * deployments that only configure ENCRYPTION_KEY.
 *
 * Uses truthy checks (not nullish coalescing) so that empty strings from
 * misconfigured CI/CD pipelines also trigger the fallback.
 */

interface SecretsEnv {
  ENCRYPTION_KEY: string;
  BETTER_AUTH_SECRET?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
}

/** Key used by BetterAuth for session signing/encryption. */
export function getBetterAuthSecret(env: SecretsEnv): string {
  return env.BETTER_AUTH_SECRET || env.ENCRYPTION_KEY;
}

/** Key used for AES-GCM encryption of user credentials (cloud tokens, etc.). */
export function getCredentialEncryptionKey(env: SecretsEnv): string {
  return env.CREDENTIAL_ENCRYPTION_KEY || env.ENCRYPTION_KEY;
}

/**
 * HMAC key for lookup hashes of high-entropy bearer tokens (API tokens, connector PATs, invite
 * links, webhook tokens). Only the hash is stored, and the tokens are
 * 256-bit random values, so the key cannot be used to recover or forge a token. A self-hosted
 * ENCRYPTION_KEY rotation therefore pins this to the old value instead of invalidating every
 * issued token (scripts/selfhost/secrets-rotate*.ts). Unset: ENCRYPTION_KEY, as before.
 */
export function getTokenHashKey(env: { ENCRYPTION_KEY: string; TOKEN_HASH_KEY?: string }): string {
  return env.TOKEN_HASH_KEY || env.ENCRYPTION_KEY;
}
