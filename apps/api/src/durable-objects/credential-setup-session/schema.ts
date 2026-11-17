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
  /** 1 while teardown's sandbox cleanup has not finished; NULL/0 otherwise. */
  cleanup_pending: number | null;
  /** Status the session had when teardown claimed it (decides whether to scrub). */
  cleanup_from_status: string | null;
  /** Number of recovery work attempts; pending SDK watchdog wakes do not count. */
  cleanup_attempts: number | null;
  /** Immutable per-cleanup retry policy; NULL legacy retains the original cap. */
  cleanup_recovery_max_attempts: number | null;
  /** One late scrub or successful destroy may continue its existing work attempt. */
  cleanup_settlement_credit: number | null;
  /** 1 only after sandbox.destroy() succeeds; recovery must not restart that sandbox. */
  cleanup_sandbox_destroyed: number | null;
  /** NULL: scrub needed; 1: SDK exec may still start work; 2: scrub succeeded. */
  cleanup_scrub_state: number | null;
  /** NULL legacy; positive count of original SDK flights; 0 all observed settled. */
  cleanup_sandbox_io_pending: number | null;
};

export type DeviceAuthDetailsRow = {
  verification_url: string;
  user_code: string | null;
};

/**
 * Teardown-recovery columns, added after the table first shipped. Each carries its full
 * literal statement (DDL cannot take placeholders, and a literal is what the safety check
 * scans). Nullable with no default: legacy rows owe no cleanup unless marked pending, and
 * NULL sandbox-destroyed means no destruction proof, so interrupted legacy cleanup
 * still scrubs and destroys before releasing its obligation.
 */
const CLEANUP_COLUMNS: ReadonlyArray<readonly [name: string, ddl: string]> = [
  ['cleanup_pending', 'ALTER TABLE setup_session ADD COLUMN cleanup_pending INTEGER'],
  ['cleanup_from_status', 'ALTER TABLE setup_session ADD COLUMN cleanup_from_status TEXT'],
  ['cleanup_attempts', 'ALTER TABLE setup_session ADD COLUMN cleanup_attempts INTEGER'],
  [
    'cleanup_recovery_max_attempts',
    'ALTER TABLE setup_session ADD COLUMN cleanup_recovery_max_attempts INTEGER',
  ],
  [
    'cleanup_settlement_credit',
    'ALTER TABLE setup_session ADD COLUMN cleanup_settlement_credit INTEGER',
  ],
  ['cleanup_scrub_state', 'ALTER TABLE setup_session ADD COLUMN cleanup_scrub_state INTEGER'],
  [
    'cleanup_sandbox_io_pending',
    'ALTER TABLE setup_session ADD COLUMN cleanup_sandbox_io_pending INTEGER',
  ],
  [
    'cleanup_sandbox_destroyed',
    'ALTER TABLE setup_session ADD COLUMN cleanup_sandbox_destroyed INTEGER',
  ],
];

/**
 * Create the tables if absent and add any missing additive column. Runs in the DO
 * constructor; idempotent. The PRAGMA is one local SQLite read per constructor run.
 */
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
  const existingColumns = new Set(
    sql
      .exec<{ name: string }>('PRAGMA table_info(setup_session)')
      .toArray()
      .map((column) => column.name)
  );
  for (const [name, ddl] of CLEANUP_COLUMNS) {
    if (!existingColumns.has(name)) sql.exec(ddl);
  }
}
