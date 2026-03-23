/**
 * Secret key resolution helpers.
 *
 * Each helper returns the purpose-specific secret when set, falling back to
 * the shared ENCRYPTION_KEY for backwards compatibility with existing
 * deployments that only configure ENCRYPTION_KEY.
 */

interface SecretsEnv {
  ENCRYPTION_KEY: string;
  BETTER_AUTH_SECRET?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
}

/** Key used by BetterAuth for session signing/encryption. */
export function getBetterAuthSecret(env: SecretsEnv): string {
  return env.BETTER_AUTH_SECRET ?? env.ENCRYPTION_KEY;
}

/** Key used for AES-GCM encryption of user credentials (cloud tokens, etc.). */
export function getCredentialEncryptionKey(env: SecretsEnv): string {
  return env.CREDENTIAL_ENCRYPTION_KEY ?? env.ENCRYPTION_KEY;
}

/** Secret used for GitHub webhook HMAC-SHA256 signature verification. */
export function getWebhookSecret(env: SecretsEnv): string {
  return env.GITHUB_WEBHOOK_SECRET ?? env.ENCRYPTION_KEY;
}
