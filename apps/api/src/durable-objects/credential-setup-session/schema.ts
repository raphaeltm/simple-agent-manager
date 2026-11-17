/**
 * DO-SQLite schema for CredentialSetupSession: the row types and every DDL
 * statement the object runs. Kept apart from the DO (which also writes D1 through
 * a dynamic SET) so `pnpm quality:do-migration-safety` can scan all of it
 * (scripts/quality/check-do-migration-safety.ts).
 *
 * Changes here must stay additive: CREATE TABLE IF NOT EXISTS, or a guarded
 * ALTER TABLE ADD COLUMN for objects created before a column existed. Never
 * drop or recreate a table: DO SQLite has no recovery (rule 31).
 */

// `type` (not `interface`) so it carries an implicit index signature and
// satisfies the `Record<string, SqlStorageValue>` constraint on sql.exec<T>().
export type SetupSessionRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  scope: string;
  agent_type: string;
  credential_kind: string;
  provider: string;
  agent_name: string;
  status: string;
  pool_lease_id: string | null;
  codex_home: string;
  expires_at: number;
  capture_poll_ms: number;
  error_code: string | null;
  error_message: string | null;
  completed_at: number | null;
};

export type DeviceAuthDetailsRow = {
  verification_url: string;
  user_code: string | null;
};

/** Create the tables if absent. Runs in the DO constructor; idempotent. */
export function ensureSetupSessionSchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS setup_session (
      id              TEXT PRIMARY KEY NOT NULL,
      user_id         TEXT NOT NULL,
      project_id      TEXT,
      scope           TEXT NOT NULL,
      agent_type      TEXT NOT NULL,
      credential_kind TEXT NOT NULL,
      provider        TEXT NOT NULL,
      agent_name      TEXT NOT NULL,
      status          TEXT NOT NULL,
      pool_lease_id   TEXT,
      codex_home      TEXT NOT NULL,
      expires_at      INTEGER NOT NULL,
      capture_poll_ms INTEGER NOT NULL,
      error_code      TEXT,
      error_message   TEXT,
      completed_at    INTEGER
    )`
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS device_auth_details (
      singleton        INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
      verification_url TEXT NOT NULL,
      user_code        TEXT
    )`
  );
}
