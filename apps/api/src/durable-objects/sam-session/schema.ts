export function migrateSamHistory(sql: SqlStorage): void {
  // Create migrations tracking table
  sql.exec(`
    CREATE TABLE IF NOT EXISTS sam_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  const applied = new Set(
    sql
      .exec('SELECT name FROM sam_migrations')
      .toArray()
      .map((r) => String(r.name))
  );

  if (!applied.has('001-initial')) {
    sql.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    sql.exec(`CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC)`);

    sql.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        tool_calls_json TEXT,
        tool_call_id TEXT,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    sql.exec(`CREATE INDEX idx_messages_conv_seq ON messages(conversation_id, sequence ASC)`);

    sql.exec(`INSERT INTO sam_migrations (name) VALUES ('001-initial')`);
  }

  if (!applied.has('002-rate-limits')) {
    sql.exec(`
      CREATE TABLE rate_limits (
        id INTEGER PRIMARY KEY,
        window_start INTEGER NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    sql.exec(`INSERT INTO rate_limits (id, window_start, request_count) VALUES (1, 0, 0)`);
    sql.exec(`INSERT INTO sam_migrations (name) VALUES ('002-rate-limits')`);
  }

  if (!applied.has('003-fts-and-type')) {
    // Forward-compatible columns for Phase 3 (project agent threads)
    sql.exec(`ALTER TABLE conversations ADD COLUMN type TEXT NOT NULL DEFAULT 'human'`);
    sql.exec(`ALTER TABLE conversations ADD COLUMN linked_session_id TEXT`);
    sql.exec(`ALTER TABLE conversations ADD COLUMN linked_project_id TEXT`);

    // FTS5 virtual table for full-text search on message content
    sql.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
      USING fts5(content, content='messages', content_rowid='rowid', tokenize='unicode61')
    `);

    // Backfill existing messages into FTS5
    sql.exec(`
      INSERT INTO messages_fts(rowid, content)
      SELECT rowid, content FROM messages WHERE content != ''
    `);

    sql.exec(`INSERT INTO sam_migrations (name) VALUES ('003-fts-and-type')`);
  }
}
