/**
 * DO migration 073: one set of comment tables for every anchor kind.
 *
 * Why unified tables do not repeat the incident in .claude/rules/63:
 * - Nothing is widened or relaxed. These are NEW tables; the old ones are untouched.
 * - The scope columns `anchor_kind` and `scope_key` are NOT NULL on every row of every
 *   table, so no row can exist without a scope and every predicate has a value to bind.
 * - Per-kind CHECKs pin the typed columns: a message row must have `session_id` and
 *   `message_id` with `scope_key = session_id` and no `file_id`; a library-file row must
 *   have `file_id` with `scope_key = file_id` and no session or message. A file row can
 *   therefore never be matched by a session lookup, and the reverse.
 * - The queries are built from a typed scope (`anchored-comment-scope.ts`), not a column
 *   a caller may omit.
 *
 * `anchor_kind` has no table-level set CHECK on purpose: SQLite cannot widen a CHECK
 * without recreating the table. A new kind is added with
 * `ALTER TABLE ... ADD COLUMN <kind>_id TEXT CHECK (...)` instead (see the scope module).
 *
 * Copy: the legacy rows are copied with ids, sequences, versions, timestamps, mentions and
 * idempotency fingerprints preserved, so deep links, inbox entries, prompt-delivery
 * `commentThreadId` metadata and notification links keep resolving, and a client retrying
 * a pre-migration mutation still gets its idempotent replay. The copy skips rows already
 * present, so running it again is a no-op. The legacy tables stay in place, frozen and
 * unwritten (`anchored-comment-writer-inventory.test.ts`), as the recovery path; dropping
 * them is a separate, later change (tasks/backlog/2026-11-05-drop-frozen-legacy-comment-tables.md).
 *
 * Rollback: this migration is recorded once per object and never re-runs. If the Worker is
 * rolled back to code from before 073, that code reads and writes only the legacy tables, and
 * anything written during the rollback window is invisible after rolling forward again. Roll
 * forward with a new migration that calls `copyLegacyCommentRows` (idempotent: it adds only
 * missing rows). Status changes made during the window to rows that already exist here are
 * not merged.
 *
 * Cost (rule 81): both steps run in-engine, inside the constructor's blockConcurrencyWhile
 * (30 s budget). Measured on better-sqlite3 with 100,000 threads and 100,000 replies of ~200
 * bytes each: copy 1.9 s, parity 1.4 s. Comment threads are capped per session
 * (`COMMENT_THREADS_PER_SESSION_MAX`); the largest staging project had 35 threads.
 *
 * Parity is checked after the copy and logged. A mismatch is logged as an error and does
 * NOT throw: migrations run inside the DO constructor's transaction, and a throw would take
 * the whole project object down rather than leave comments partly visible.
 *
 * Do not put quoted SQL fragments in comments here: the DO migration safety scanner reads
 * every quoted literal in this file as SQL.
 */
import { createModuleLogger } from '@simple-agent-manager/worker-core';

const log = createModuleLogger('project_data.anchored_comments_migration');

const THREAD_COLUMNS = {
  id: 'TEXT PRIMARY KEY',
  anchor_kind: 'TEXT NOT NULL',
  scope_key: 'TEXT NOT NULL',
  session_id: 'TEXT REFERENCES chat_sessions(id) ON DELETE CASCADE',
  message_id: 'TEXT REFERENCES chat_messages(id) ON DELETE CASCADE',
  file_id: 'TEXT',
  quote: 'TEXT',
  body: 'TEXT NOT NULL',
  author_type: "TEXT NOT NULL CHECK (author_type IN ('human', 'agent'))",
  author_id: 'TEXT NOT NULL',
  author_name: 'TEXT',
  status: "TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sent', 'resolved'))",
  created_at: 'INTEGER NOT NULL',
  updated_at: 'INTEGER NOT NULL',
  sequence: 'INTEGER NOT NULL',
  version: 'INTEGER NOT NULL DEFAULT 1',
  client_mutation_id: 'TEXT',
  client_mutation_fingerprint: 'TEXT',
  sent_at: 'INTEGER',
  sent_by_type: "TEXT CHECK (sent_by_type IS NULL OR sent_by_type IN ('human', 'agent'))",
  sent_by_id: 'TEXT',
  sent_by_name: 'TEXT',
  resolved_at: 'INTEGER',
  resolved_by_type:
    "TEXT CHECK (resolved_by_type IS NULL OR resolved_by_type IN ('human', 'agent'))",
  resolved_by_id: 'TEXT',
  resolved_by_name: 'TEXT',
  reopened_at: 'INTEGER',
  reopened_by_type:
    "TEXT CHECK (reopened_by_type IS NULL OR reopened_by_type IN ('human', 'agent'))",
  reopened_by_id: 'TEXT',
  reopened_by_name: 'TEXT',
  mentions_json: 'TEXT',
} as const;

const THREAD_CONSTRAINTS = [
  "CHECK (anchor_kind <> 'message' OR (session_id IS NOT NULL AND message_id IS NOT NULL AND scope_key = session_id AND file_id IS NULL))",
  "CHECK (anchor_kind <> 'library_file' OR (file_id IS NOT NULL AND scope_key = file_id AND session_id IS NULL AND message_id IS NULL))",
  "CHECK (anchor_kind = 'message' OR (session_id IS NULL AND message_id IS NULL AND sent_at IS NULL))",
  'UNIQUE (anchor_kind, scope_key, client_mutation_id)',
];

function columnList(columns: Record<string, string>, constraints: string[] = []): string {
  return [
    ...Object.entries(columns).map(([name, definition]) => `${name} ${definition}`),
    ...constraints,
  ].join(',\n  ');
}

/** Column names copied verbatim from both legacy thread tables. */
const SHARED_THREAD_COPY_COLUMNS = [
  'id',
  'quote',
  'body',
  'author_type',
  'author_id',
  'author_name',
  'status',
  'created_at',
  'updated_at',
  'sequence',
  'version',
  'client_mutation_id',
  'client_mutation_fingerprint',
  'resolved_at',
  'resolved_by_type',
  'resolved_by_id',
  'resolved_by_name',
  'reopened_at',
  'reopened_by_type',
  'reopened_by_id',
  'reopened_by_name',
].join(', ');

const SENT_COLUMNS = 'sent_at, sent_by_type, sent_by_id, sent_by_name';

const CREATE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS anchored_comment_threads (
  ${columnList(THREAD_COLUMNS, THREAD_CONSTRAINTS)}
)`,
  `CREATE TABLE IF NOT EXISTS anchored_comment_replies (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES anchored_comment_threads(id) ON DELETE CASCADE,
  anchor_kind TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  body TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('human', 'agent')),
  author_id TEXT NOT NULL,
  author_name TEXT,
  created_at INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  client_mutation_id TEXT,
  client_mutation_fingerprint TEXT,
  mentions_json TEXT,
  UNIQUE (thread_id, client_mutation_id)
)`,
  `CREATE TABLE IF NOT EXISTS anchored_comment_status_mutations (
  thread_id TEXT NOT NULL REFERENCES anchored_comment_threads(id) ON DELETE CASCADE,
  anchor_kind TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  client_mutation_id TEXT NOT NULL,
  target_status TEXT NOT NULL CHECK (target_status IN ('open', 'sent', 'resolved')),
  thread_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, client_mutation_id)
)`,
  'CREATE INDEX IF NOT EXISTS idx_anchored_comment_threads_scope_sequence ON anchored_comment_threads(anchor_kind, scope_key, sequence)',
  'CREATE INDEX IF NOT EXISTS idx_anchored_comment_threads_scope_status ON anchored_comment_threads(anchor_kind, scope_key, status, sequence)',
  'CREATE INDEX IF NOT EXISTS idx_anchored_comment_threads_message ON anchored_comment_threads(anchor_kind, scope_key, message_id, sequence)',
  'CREATE INDEX IF NOT EXISTS idx_anchored_comment_threads_updated_at ON anchored_comment_threads(updated_at DESC, id)',
  'CREATE INDEX IF NOT EXISTS idx_anchored_comment_threads_status_updated_at ON anchored_comment_threads(status, updated_at DESC, id)',
  'CREATE INDEX IF NOT EXISTS idx_anchored_comment_replies_thread_sequence ON anchored_comment_replies(thread_id, sequence)',
  'CREATE INDEX IF NOT EXISTS idx_anchored_comment_replies_scope ON anchored_comment_replies(anchor_kind, scope_key)',
];

export function createAnchoredCommentTables(sql: SqlStorage): void {
  for (const statement of CREATE_STATEMENTS) sql.exec(statement);
}

const REPLY_COPY_COLUMNS =
  'id, thread_id, body, author_type, author_id, author_name, created_at, sequence, client_mutation_id, client_mutation_fingerprint';
const MUTATION_COPY_COLUMNS =
  'thread_id, client_mutation_id, target_status, thread_version, created_at';

/** Threads first, so replies and mutations satisfy their foreign keys. */
const COPY_STATEMENTS: readonly string[] = [
  `INSERT INTO anchored_comment_threads
    (${SHARED_THREAD_COPY_COLUMNS}, anchor_kind, scope_key, session_id, message_id, file_id,
     ${SENT_COLUMNS}, mentions_json)
  SELECT ${SHARED_THREAD_COPY_COLUMNS}, 'message', session_id, session_id, message_id, NULL,
     ${SENT_COLUMNS}, mentions_json
  FROM comment_threads legacy
  WHERE NOT EXISTS (SELECT 1 FROM anchored_comment_threads a WHERE a.id = legacy.id)`,
  `INSERT INTO anchored_comment_threads
    (${SHARED_THREAD_COPY_COLUMNS}, anchor_kind, scope_key, session_id, message_id, file_id)
  SELECT ${SHARED_THREAD_COPY_COLUMNS}, 'library_file', file_id, NULL, NULL, file_id
  FROM library_file_comment_threads legacy
  WHERE NOT EXISTS (SELECT 1 FROM anchored_comment_threads a WHERE a.id = legacy.id)`,
  `INSERT INTO anchored_comment_replies
    (${REPLY_COPY_COLUMNS}, anchor_kind, scope_key, mentions_json)
  SELECT ${REPLY_COPY_COLUMNS}, 'message', session_id, mentions_json
  FROM comment_replies legacy
  WHERE NOT EXISTS (SELECT 1 FROM anchored_comment_replies a WHERE a.id = legacy.id)`,
  `INSERT INTO anchored_comment_replies
    (${REPLY_COPY_COLUMNS}, anchor_kind, scope_key)
  SELECT ${REPLY_COPY_COLUMNS}, 'library_file', file_id
  FROM library_file_comment_replies legacy
  WHERE NOT EXISTS (SELECT 1 FROM anchored_comment_replies a WHERE a.id = legacy.id)`,
  `INSERT INTO anchored_comment_status_mutations
    (${MUTATION_COPY_COLUMNS}, anchor_kind, scope_key)
  SELECT ${MUTATION_COPY_COLUMNS}, 'message', session_id
  FROM comment_status_mutations legacy
  WHERE NOT EXISTS (
    SELECT 1 FROM anchored_comment_status_mutations a
    WHERE a.thread_id = legacy.thread_id AND a.client_mutation_id = legacy.client_mutation_id
  )`,
  `INSERT INTO anchored_comment_status_mutations
    (${MUTATION_COPY_COLUMNS}, anchor_kind, scope_key)
  SELECT ${MUTATION_COPY_COLUMNS}, 'library_file', file_id
  FROM library_file_comment_status_mutations legacy
  WHERE NOT EXISTS (
    SELECT 1 FROM anchored_comment_status_mutations a
    WHERE a.thread_id = legacy.thread_id AND a.client_mutation_id = legacy.client_mutation_id
  )`,
];

/**
 * Copy every legacy row that is not already in the anchored tables. Safe to run again:
 * a second run inserts nothing. Threads go first so replies and mutations satisfy their
 * foreign keys.
 */
export function copyLegacyCommentRows(sql: SqlStorage): void {
  for (const statement of COPY_STATEMENTS) sql.exec(statement);
}

export interface CommentParityCheck {
  name: string;
  legacyCount: number;
  anchoredCount: number;
  /** Legacy rows with no identical anchored row (missing or with any differing column). */
  mismatched: number;
}

export interface CommentParityReport {
  ok: boolean;
  checks: CommentParityCheck[];
}

/**
 * Each check compares one legacy table with its anchor-kind slice of the anchored table:
 * the row counts, and an EXCEPT over every copied column (which treats NULLs as equal).
 */
const PARITY_CHECKS: Array<{ name: string; legacy: string; anchored: string }> = [
  {
    name: 'message_threads',
    legacy: `SELECT ${SHARED_THREAD_COPY_COLUMNS}, session_id, message_id, ${SENT_COLUMNS}, mentions_json FROM comment_threads`,
    anchored: `SELECT ${SHARED_THREAD_COPY_COLUMNS}, scope_key, message_id, ${SENT_COLUMNS}, mentions_json FROM anchored_comment_threads WHERE anchor_kind = 'message'`,
  },
  {
    name: 'file_threads',
    legacy: `SELECT ${SHARED_THREAD_COPY_COLUMNS}, file_id FROM library_file_comment_threads`,
    anchored: `SELECT ${SHARED_THREAD_COPY_COLUMNS}, scope_key FROM anchored_comment_threads WHERE anchor_kind = 'library_file'`,
  },
  {
    name: 'message_replies',
    legacy:
      'SELECT id, thread_id, session_id, body, author_type, author_id, author_name, created_at, sequence, client_mutation_id, client_mutation_fingerprint, mentions_json FROM comment_replies',
    anchored:
      "SELECT id, thread_id, scope_key, body, author_type, author_id, author_name, created_at, sequence, client_mutation_id, client_mutation_fingerprint, mentions_json FROM anchored_comment_replies WHERE anchor_kind = 'message'",
  },
  {
    name: 'file_replies',
    legacy:
      'SELECT id, thread_id, file_id, body, author_type, author_id, author_name, created_at, sequence, client_mutation_id, client_mutation_fingerprint FROM library_file_comment_replies',
    anchored:
      "SELECT id, thread_id, scope_key, body, author_type, author_id, author_name, created_at, sequence, client_mutation_id, client_mutation_fingerprint FROM anchored_comment_replies WHERE anchor_kind = 'library_file'",
  },
  {
    name: 'message_status_mutations',
    legacy:
      'SELECT thread_id, session_id, client_mutation_id, target_status, thread_version, created_at FROM comment_status_mutations',
    anchored:
      "SELECT thread_id, scope_key, client_mutation_id, target_status, thread_version, created_at FROM anchored_comment_status_mutations WHERE anchor_kind = 'message'",
  },
  {
    name: 'file_status_mutations',
    legacy:
      'SELECT thread_id, file_id, client_mutation_id, target_status, thread_version, created_at FROM library_file_comment_status_mutations',
    anchored:
      "SELECT thread_id, scope_key, client_mutation_id, target_status, thread_version, created_at FROM anchored_comment_status_mutations WHERE anchor_kind = 'library_file'",
  },
];

/** The three counting statements per check, built at module load. */
const PARITY_COUNT_STATEMENTS = PARITY_CHECKS.map(({ name, legacy, anchored }) => ({
  name,
  legacy: `SELECT COUNT(*) AS count FROM (${legacy})`,
  anchored: `SELECT COUNT(*) AS count FROM (${anchored})`,
  mismatched: `SELECT COUNT(*) AS count FROM (${legacy} EXCEPT ${anchored})`,
}));

function count(sql: SqlStorage, statement: string): number {
  const row = sql.exec(statement).toArray()[0];
  return typeof row?.count === 'number' ? row.count : 0;
}

export function checkLegacyCommentParity(sql: SqlStorage): CommentParityReport {
  const checks = PARITY_COUNT_STATEMENTS.map((statements) => ({
    name: statements.name,
    legacyCount: count(sql, statements.legacy),
    anchoredCount: count(sql, statements.anchored),
    mismatched: count(sql, statements.mismatched),
  }));
  return {
    ok: checks.every((c) => c.mismatched === 0 && c.legacyCount === c.anchoredCount),
    checks,
  };
}

function readProjectId(sql: SqlStorage): string | null {
  try {
    const row = sql.exec('SELECT value FROM do_meta WHERE key = ?', 'projectId').toArray()[0];
    return typeof row?.value === 'string' ? row.value : null;
  } catch {
    return null;
  }
}

export function migrateAnchoredComments(sql: SqlStorage): void {
  createAnchoredCommentTables(sql);
  copyLegacyCommentRows(sql);
  const report = checkLegacyCommentParity(sql);
  const context = { projectId: readProjectId(sql), ok: report.ok, checks: report.checks };
  if (report.ok) {
    log.info('comments.migration_parity', context);
  } else {
    log.error('comments.migration_parity_mismatch', context);
  }
}
