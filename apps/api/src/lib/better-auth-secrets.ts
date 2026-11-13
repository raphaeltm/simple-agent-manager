/**
 * BetterAuth secret configuration, including optional versioned rotation.
 *
 * Default (BETTER_AUTH_SECRET_VERSION unset): BetterAuth receives only `secret`, exactly as before
 * rotation support existed. OAuth tokens stay legacy bare-hex ciphertext keyed by that secret.
 *
 * Versioned mode (BETTER_AUTH_SECRET_VERSION set): BetterAuth receives `secrets`, whose first entry
 * is the current secret. New ciphertext is written as `$ba$<version>$<hex>` envelopes, envelopes
 * decrypt by version, and bare-hex payloads decrypt with the legacy `secret` option. This lets a
 * self-hosted install rotate the secret without losing stored OAuth tokens:
 *
 * - first rotation (from an unversioned secret): BETTER_AUTH_SECRET=<new>,
 *   BETTER_AUTH_SECRET_VERSION=1, BETTER_AUTH_SECRET_PREVIOUS=<old>. Old bare-hex tokens decrypt
 *   with <old>.
 * - later rotation: BETTER_AUTH_SECRET=<new>, BETTER_AUTH_SECRET_VERSION=N+1,
 *   BETTER_AUTH_SECRET_PREVIOUS=<old>, BETTER_AUTH_SECRET_PREVIOUS_VERSION=N.
 *
 * The current secret is always `getBetterAuthSecret(env)`, which BetterAuth then uses for cookie
 * signing (`secrets[0].value`); `services/session-factory.ts` signs API-token session cookies with
 * the same helper, so the two cannot diverge.
 *
 * Mirrors better-auth's `createAuthContext` / `buildSecretConfig`
 * (better-auth/dist/context/create-context.mjs, context/secret-utils.mjs).
 */
import type { BetterAuthOptions } from 'better-auth';
import type { SecretConfig } from 'better-auth/crypto';

import { getBetterAuthSecret } from './secrets';

export interface BetterAuthSecretsEnv {
  ENCRYPTION_KEY: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_SECRET_VERSION?: string;
  BETTER_AUTH_SECRET_PREVIOUS?: string;
  BETTER_AUTH_SECRET_PREVIOUS_VERSION?: string;
}

export type BetterAuthSecretOptions = Pick<BetterAuthOptions, 'secret' | 'secrets'>;

type VersionedSecret = NonNullable<BetterAuthOptions['secrets']>[number];

const POSITIVE_INTEGER = /^[1-9]\d*$/;

function parseVersion(name: string, raw: string): number {
  const trimmed = raw.trim();
  const version = Number(trimmed);
  if (!POSITIVE_INTEGER.test(trimmed) || !Number.isSafeInteger(version)) {
    throw new Error(
      `Invalid ${name}: expected a positive integer secret version. ` +
        'Fix the BetterAuth secret configuration; refusing to start with an ambiguous key set.'
    );
  }
  return version;
}

/**
 * Options to spread into `betterAuth({...})`. Returns `{ secret }` alone when versioning is not
 * configured, and `{ secret, secrets }` otherwise. Throws on an invalid or contradictory
 * configuration rather than silently dropping a key that stored tokens depend on.
 */
export function betterAuthSecretOptions(env: BetterAuthSecretsEnv): BetterAuthSecretOptions {
  const current = getBetterAuthSecret(env);
  // Truthy checks, matching lib/secrets.ts: empty strings from CI/CD mean "unset".
  const previous = env.BETTER_AUTH_SECRET_PREVIOUS || undefined;
  const previousVersionRaw = env.BETTER_AUTH_SECRET_PREVIOUS_VERSION || undefined;

  if (!env.BETTER_AUTH_SECRET_VERSION) {
    if (previous || previousVersionRaw) {
      throw new Error(
        'BETTER_AUTH_SECRET_PREVIOUS / BETTER_AUTH_SECRET_PREVIOUS_VERSION require ' +
          'BETTER_AUTH_SECRET_VERSION; without it the previous secret would be ignored and ' +
          'tokens encrypted under it could not be decrypted.'
      );
    }
    return { secret: current };
  }

  const version = parseVersion('BETTER_AUTH_SECRET_VERSION', env.BETTER_AUTH_SECRET_VERSION);
  const secrets: VersionedSecret[] = [{ version, value: current }];
  let legacySecret = current;

  if (previousVersionRaw) {
    if (!previous) {
      throw new Error(
        'BETTER_AUTH_SECRET_PREVIOUS_VERSION is set but BETTER_AUTH_SECRET_PREVIOUS is not.'
      );
    }
    const previousVersion = parseVersion('BETTER_AUTH_SECRET_PREVIOUS_VERSION', previousVersionRaw);
    if (previousVersion !== version) {
      secrets.push({ version: previousVersion, value: previous });
    } else if (previous !== current) {
      throw new Error(
        'BETTER_AUTH_SECRET_PREVIOUS_VERSION equals BETTER_AUTH_SECRET_VERSION but the secret ' +
          'values differ; a rotation must use a new version number.'
      );
    }
  } else if (previous) {
    // The previous secret was unversioned: its ciphertext is legacy bare hex.
    legacySecret = previous;
  }

  return { secret: legacySecret, secrets };
}

/**
 * The exact `key` better-auth's `symmetricEncrypt`/`symmetricDecrypt` use for this env
 * (`ctx.secretConfig`): the secret string in default mode, or the versioned SecretConfig.
 */
export function betterAuthSymmetricKey(env: BetterAuthSecretsEnv): string | SecretConfig {
  const { secret, secrets } = betterAuthSecretOptions(env);
  const current = secrets?.[0];
  if (!secrets || !current) return secret ?? '';
  const keys = new Map<number, string>();
  for (const entry of secrets) keys.set(entry.version, entry.value);
  return {
    keys,
    currentVersion: current.version,
    legacySecret: secret || undefined,
  };
}
