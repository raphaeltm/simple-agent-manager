/**
 * Which AES keys a self-hosted rotation moves, derived from the Worker env exactly the way the
 * app resolves them, so the rotation can never re-encrypt under a key the app does not read with.
 *
 * Each role's previous key is the same resolver applied to the env with every `<NAME>_PREVIOUS`
 * laid over `<NAME>`. A role whose previous key equals its current key is not rotating (for
 * example the credential role while only LIBRARY_ENCRYPTION_KEY rotates).
 */
import { getCredentialEncryptionKey } from '../../lib/secrets';

/** Names that can carry a `<NAME>_PREVIOUS` value during a rotation. */
export const ROTATABLE_AES_KEY_NAMES = [
  'ENCRYPTION_KEY',
  'CREDENTIAL_ENCRYPTION_KEY',
  'LIBRARY_ENCRYPTION_KEY',
] as const;

export interface AesKeyEnv {
  ENCRYPTION_KEY: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  LIBRARY_ENCRYPTION_KEY?: string;
  ENCRYPTION_KEY_PREVIOUS?: string;
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS?: string;
  LIBRARY_ENCRYPTION_KEY_PREVIOUS?: string;
}

/**
 * The resolvers the app uses, by role:
 * - `credential`: getCredentialEncryptionKey (`||`), every credential table but one;
 * - `credential-nullish`: `CREDENTIAL_ENCRYPTION_KEY ?? ENCRYPTION_KEY`
 *   (routes/deployment-secrets.ts, routes/deployment-releases.ts);
 * - `library`: `LIBRARY_ENCRYPTION_KEY ?? ENCRYPTION_KEY` (routes/library-route-helpers.ts).
 */
export type AesKeyRole = 'credential' | 'credential-nullish' | 'library';

function resolve(role: AesKeyRole, env: AesKeyEnv): string {
  if (role === 'credential') return getCredentialEncryptionKey(env);
  if (role === 'credential-nullish') return env.CREDENTIAL_ENCRYPTION_KEY ?? env.ENCRYPTION_KEY;
  return env.LIBRARY_ENCRYPTION_KEY ?? env.ENCRYPTION_KEY;
}

function previousEnv(env: AesKeyEnv): AesKeyEnv {
  return {
    ...env,
    ENCRYPTION_KEY: env.ENCRYPTION_KEY_PREVIOUS || env.ENCRYPTION_KEY,
    CREDENTIAL_ENCRYPTION_KEY:
      env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS || env.CREDENTIAL_ENCRYPTION_KEY,
    LIBRARY_ENCRYPTION_KEY: env.LIBRARY_ENCRYPTION_KEY_PREVIOUS || env.LIBRARY_ENCRYPTION_KEY,
  };
}

export interface RoleKeys {
  current: string;
  /** Null when this role is not rotating. */
  previous: string | null;
}

export function roleKeys(role: AesKeyRole, env: AesKeyEnv): RoleKeys {
  const current = resolve(role, env);
  const previous = resolve(role, previousEnv(env));
  return { current, previous: previous && previous !== current ? previous : null };
}

/** current -> previous for every rotating role: the read fallback (encryption-key-fallback.ts). */
export function previousKeyPairs(env: AesKeyEnv): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const role of ['credential', 'credential-nullish', 'library'] as const) {
    const keys = roleKeys(role, env);
    if (keys.previous) pairs.set(keys.current, keys.previous);
  }
  return pairs;
}
