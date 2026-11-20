/**
 * One bounded page of a self-hosted BetterAuth secret rotation over `accounts`, whose
 * access_token / refresh_token better-auth stores encrypted (`encryptOAuthTokens: true`):
 * legacy bare hex under the unversioned secret, or `$ba$<version>$` envelopes in versioned mode
 * (lib/better-auth-secrets.ts).
 *
 * During the rotation better-auth itself reads both (current version + previous, or the previous
 * as legacy secret). `migrate` rewrites every token that does not open under the current version
 * alone as a current-version envelope, with better-auth's own crypto; `verify` proves every token
 * opens under the current version alone. Compare-and-set on the exact value read; a token that
 * opens under neither is reported and left alone.
 */
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';

import { type BetterAuthSecretsEnv, betterAuthSymmetricKey } from '../../lib/better-auth-secrets';
import { MAX_REPORTED_ROWS, type PassInput, type PassMode, type PassResult } from './d1-pass';

export const BETTER_AUTH_LOCATION = 'accounts';
const TOKEN_COLUMNS = ['access_token', 'refresh_token'] as const;

type SymmetricKey = Parameters<typeof symmetricDecrypt>[0]['key'];

/** The configured key with only the current version: what is left once the rotation ends. */
function currentOnly(key: SymmetricKey): SymmetricKey | null {
  if (typeof key === 'string') return null;
  const current = key.keys.get(key.currentVersion);
  if (!current) return null;
  return { keys: new Map([[key.currentVersion, current]]), currentVersion: key.currentVersion };
}

async function opens(data: string, key: SymmetricKey): Promise<string | null> {
  try {
    return await symmetricDecrypt({ key, data });
  } catch {
    return null;
  }
}

/** Whether this env is in the middle of a BetterAuth rotation (versioned mode with a previous). */
export function betterAuthRotating(env: BetterAuthSecretsEnv): boolean {
  return Boolean(env.BETTER_AUTH_SECRET_VERSION && env.BETTER_AUTH_SECRET_PREVIOUS);
}

export async function runBetterAuthPass(
  db: D1Database,
  env: BetterAuthSecretsEnv,
  mode: PassMode,
  input: PassInput
): Promise<PassResult> {
  const now = input.now ?? Date.now;
  const result: PassResult = {
    location: BETTER_AUTH_LOCATION,
    mode,
    nextCursor: input.cursor,
    done: false,
    scanned: 0,
    current: 0,
    migrated: 0,
    previous: 0,
    unreadable: 0,
    previousRows: [],
    unreadableRows: [],
  };
  const full = betterAuthSymmetricKey(env);
  const strict = currentOnly(full);
  if (!strict)
    throw new Error('BETTER_AUTH_SECRET_VERSION is not set: no versioned secret to rotate to');
  const { results } = await db
    .prepare(
      'SELECT id, access_token, refresh_token FROM accounts WHERE id > ? ORDER BY id LIMIT ?'
    )
    .bind(input.cursor ?? '', input.limit)
    .all<Record<string, unknown>>();
  let processed = 0;
  for (const row of results) {
    if (processed > 0 && now() > input.deadlineMs) return result;
    processed += 1;
    const id = String(row.id);
    for (const column of TOKEN_COLUMNS) {
      const value = row[column];
      if (typeof value !== 'string' || value === '') continue;
      result.scanned += 1;
      if ((await opens(value, strict)) !== null) {
        result.current += 1;
        continue;
      }
      const plaintext = await opens(value, full);
      const issue = { location: BETTER_AUTH_LOCATION, id, column };
      if (plaintext === null) {
        result.unreadable += 1;
        if (result.unreadableRows.length < MAX_REPORTED_ROWS) result.unreadableRows.push(issue);
        continue;
      }
      if (mode === 'verify') {
        result.previous += 1;
        if (result.previousRows.length < MAX_REPORTED_ROWS) result.previousRows.push(issue);
        continue;
      }
      const next = await symmetricEncrypt({ key: full, data: plaintext });
      const write = await db
        .prepare(`UPDATE accounts SET ${column} = ? WHERE id = ? AND ${column} = ?`)
        .bind(next, id, value)
        .run();
      if (write.meta.changes === 1) {
        result.migrated += 1;
      } else {
        result.previous += 1;
        if (result.previousRows.length < MAX_REPORTED_ROWS) result.previousRows.push(issue);
      }
    }
    result.nextCursor = id;
  }
  result.done = results.length < input.limit;
  return result;
}
