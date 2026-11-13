/**
 * One bounded page of a self-hosted ENCRYPTION_KEY rotation over a D1 location
 * (d1-locations.ts): `migrate` re-encrypts rows still under the previous key, `verify` proves
 * every row reads under the current key.
 *
 * Per row and column pair: current key opens it -> already done; previous key opens it ->
 * re-encrypted (migrate) or reported as still old (verify); neither opens it -> reported as
 * unreadable and never written (rules 41/50: one bad row is skipped and named, not fatal, and
 * never destroyed).
 *
 * Writes are compare-and-set on the exact (ciphertext, iv) read, so a value a user saves while
 * the pass runs is never overwritten; the next verify pass sees it (written under the current
 * key). Mirror copies and node fingerprints move in the same batch, each conditioned on the
 * primary row now holding the new pair, so they can never point at a pair that was not stored.
 *
 * Work bound (rules/81): a page stops at `limit` rows or `deadlineMs`, whichever comes first,
 * and returns the cursor (the last id fully processed); the caller loops until `done`.
 */
import { decryptWithKeyOnly, encrypt } from '../../services/encryption';
import { fingerprintEncryptedProviderCredential } from '../../services/provider-credential-exact';
import type { CipherPair, D1Location } from './d1-locations';
import type { RoleKeys } from './keys';

export type PassMode = 'migrate' | 'verify';

/** Ids are not secret; values never leave this module. */
export interface RowIssue {
  location: string;
  id: string;
  column: string;
}

export interface PassResult {
  location: string;
  mode: PassMode;
  /** The last id fully processed; pass it back to continue. Null when nothing was read. */
  nextCursor: string | null;
  done: boolean;
  /** Ciphertext values looked at (a row has one per pair). */
  scanned: number;
  current: number;
  migrated: number;
  /** Still under the previous key (verify), or lost a compare-and-set race (migrate). */
  previous: number;
  unreadable: number;
  /** Bounded samples for the report. */
  previousRows: RowIssue[];
  unreadableRows: RowIssue[];
}

export interface PassInput {
  cursor: string | null;
  limit: number;
  deadlineMs: number;
  now?: () => number;
}

const IDENTIFIER = /^[a-z_]+$/;
/** Samples returned per page; counts are always exact. */
export const MAX_REPORTED_ROWS = 100;

function assertIdentifiers(location: D1Location): void {
  const names = [
    location.table,
    ...(location.mirrors ?? []),
    ...location.pairs.flatMap((p) => [p.ciphertext, p.iv]),
  ];
  for (const name of names) {
    if (!IDENTIFIER.test(name)) throw new Error(`bad identifier in key-rotation location: ${name}`);
  }
}

type Row = Record<string, unknown>;

async function opens(ciphertext: string, iv: string, key: string): Promise<string | null> {
  try {
    return await decryptWithKeyOnly(ciphertext, iv, key);
  } catch {
    return null;
  }
}

function writeStatements(
  db: D1Database,
  location: D1Location,
  pair: CipherPair,
  id: string,
  from: { ciphertext: string; iv: string },
  to: { ciphertext: string; iv: string },
  fingerprints: { from: string; to: string } | null
): D1PreparedStatement[] {
  const { table } = location;
  const holdsNew = `EXISTS (SELECT 1 FROM ${table} WHERE id = ? AND ${pair.ciphertext} = ? AND ${pair.iv} = ?)`;
  const statements = [
    db
      .prepare(
        `UPDATE ${table} SET ${pair.ciphertext} = ?, ${pair.iv} = ? WHERE id = ? AND ${pair.ciphertext} = ? AND ${pair.iv} = ?`
      )
      .bind(to.ciphertext, to.iv, id, from.ciphertext, from.iv),
  ];
  for (const mirror of location.mirrors ?? []) {
    statements.push(
      db
        .prepare(
          `UPDATE ${mirror} SET encrypted_token = ?, iv = ? WHERE encrypted_token = ? AND iv = ? AND ${holdsNew}`
        )
        .bind(to.ciphertext, to.iv, from.ciphertext, from.iv, id, to.ciphertext, to.iv)
    );
  }
  if (fingerprints) {
    statements.push(
      db
        .prepare(
          `UPDATE nodes SET placement_credential_fingerprint = ? WHERE placement_credential_fingerprint = ? AND ${holdsNew}`
        )
        .bind(fingerprints.to, fingerprints.from, id, to.ciphertext, to.iv)
    );
  }
  return statements;
}

export async function runD1Pass(
  db: D1Database,
  location: D1Location,
  keys: RoleKeys,
  mode: PassMode,
  input: PassInput
): Promise<PassResult> {
  assertIdentifiers(location);
  const now = input.now ?? Date.now;
  const result: PassResult = {
    location: location.name,
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
  const columns = ['id', ...location.pairs.flatMap((p) => [p.ciphertext, p.iv])].join(', ');
  const { results } = await db
    .prepare(`SELECT ${columns} FROM ${location.table} WHERE id > ? ORDER BY id LIMIT ?`)
    .bind(input.cursor ?? '', input.limit)
    .all<Row>();
  let processed = 0;
  for (const row of results) {
    // At least one row per page, so a page always makes progress.
    if (processed > 0 && now() > input.deadlineMs) return result;
    processed += 1;
    const id = String(row.id);
    for (const pair of location.pairs) {
      const ciphertext = row[pair.ciphertext];
      const iv = row[pair.iv];
      if (typeof ciphertext !== 'string' || typeof iv !== 'string' || !ciphertext || !iv) continue;
      result.scanned += 1;
      if ((await opens(ciphertext, iv, keys.current)) !== null) {
        result.current += 1;
        continue;
      }
      const plaintext = keys.previous ? await opens(ciphertext, iv, keys.previous) : null;
      const issue = { location: location.name, id, column: pair.ciphertext };
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
      const sealed = await encrypt(plaintext, keys.current);
      const to = { ciphertext: sealed.ciphertext, iv: sealed.iv };
      const fingerprints = location.nodeFingerprint
        ? {
            from: await fingerprintEncryptedProviderCredential(ciphertext, iv),
            to: await fingerprintEncryptedProviderCredential(to.ciphertext, to.iv),
          }
        : null;
      const [primary] = await db.batch(
        writeStatements(db, location, pair, id, { ciphertext, iv }, to, fingerprints)
      );
      if ((primary?.meta.changes ?? 0) === 1) {
        result.migrated += 1;
      } else {
        // Changed since it was read: whatever is there now was written by the app (under the
        // current key); the verify pass checks it.
        result.previous += 1;
        if (result.previousRows.length < MAX_REPORTED_ROWS) result.previousRows.push(issue);
      }
    }
    result.nextCursor = id;
  }
  result.done = results.length < input.limit;
  return result;
}
