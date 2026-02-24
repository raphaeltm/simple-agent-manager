/**
 * Durable Object SQLite migration runner and migration definitions.
 *
 * Each project's Durable Object maintains its own SQLite database.
 * Migrations are tracked in a `migrations` table and run lazily
 * in the constructor via `blockConcurrencyWhile()`.
 *
 * See: specs/018-project-first-architecture/research.md (Decision 6)
 */

export interface Migration {
  name: string;
  run: (sql: SqlStorage) => void;
}

/**
 * Ordered list of migrations. New migrations MUST be appended to the end.
 * Never remove or reorder existing migrations.
 */
export const MIGRATIONS: Migration[] = [
  {
    name: '001-initial-schema',
    run: (sql) => {
      // Chat sessions
      sql.exec(`
        CREATE TABLE chat_sessions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT,
          topic TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          message_count INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        )
      `);
      sql.exec(`CREATE INDEX idx_chat_sessions_status ON chat_sessions(status)`);
      sql.exec(`CREATE INDEX idx_chat_sessions_started_at ON chat_sessions(started_at DESC)`);
      sql.exec(`CREATE INDEX idx_chat_sessions_workspace ON chat_sessions(workspace_id)`);

      // Chat messages (append-only)
      sql.exec(`
        CREATE TABLE chat_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          tool_metadata TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        )
      `);
      sql.exec(
        `CREATE INDEX idx_chat_messages_session_created ON chat_messages(session_id, created_at)`
      );

      // Task status events (moved from D1 for per-project isolation)
      sql.exec(`
        CREATE TABLE task_status_events (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          from_status TEXT,
          to_status TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT,
          reason TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        )
      `);
      sql.exec(
        `CREATE INDEX idx_task_status_events_task ON task_status_events(task_id, created_at)`
      );

      // Activity events
      sql.exec(`
        CREATE TABLE activity_events (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT,
          workspace_id TEXT,
          session_id TEXT,
          task_id TEXT,
          payload TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        )
      `);
      sql.exec(`CREATE INDEX idx_activity_events_created ON activity_events(created_at DESC)`);
      sql.exec(
        `CREATE INDEX idx_activity_events_type ON activity_events(event_type, created_at DESC)`
      );
    },
  },
  {
    name: '002-add-task-id-to-sessions',
    run: (sql) => {
      sql.exec(`ALTER TABLE chat_sessions ADD COLUMN task_id TEXT`);
      sql.exec(`CREATE INDEX idx_chat_sessions_task_id ON chat_sessions(task_id)`);
    },
  },
  {
    name: '003-add-do-meta',
    run: (sql) => {
      sql.exec(`
        CREATE TABLE do_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
    },
  },
];

/**
 * Run pending migrations inside a transaction.
 * Call this from `blockConcurrencyWhile()` in the DO constructor.
 */
export function runMigrations(sql: SqlStorage): void {
  // Ensure migrations tracking table exists
  sql.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  // Get set of already-applied migrations
  const applied = new Set<string>();
  const rows = sql.exec('SELECT name FROM migrations').toArray();
  for (const row of rows) {
    applied.add(row.name as string);
  }

  // Run each pending migration
  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.name)) {
      migration.run(sql);
      sql.exec(
        'INSERT INTO migrations (name, applied_at) VALUES (?, ?)',
        migration.name,
        Date.now()
      );
    }
  }
}
