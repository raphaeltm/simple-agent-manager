package messagereport

import "database/sql"

// outboxDDL is the SQLite schema for the message outbox table.
// The table uses WAL mode and is created idempotently on reporter startup.
//
// message_id has a UNIQUE constraint for deduplication — if the reporter
// crashes after inserting but before flushing, restarting will not produce
// duplicate rows (the same message_id will be skipped via INSERT OR IGNORE).
const outboxDDL = `
CREATE TABLE IF NOT EXISTS message_outbox (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	message_id      TEXT    NOT NULL UNIQUE,
	session_id      TEXT    NOT NULL,
	role            TEXT    NOT NULL,
	content         TEXT    NOT NULL,
	tool_metadata   TEXT,
	created_at      TEXT    NOT NULL,
	attempts        INTEGER NOT NULL DEFAULT 0,
	last_attempt_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_message_outbox_created
	ON message_outbox(created_at);
`

// migrateOutbox creates the message_outbox table if it does not already exist.
// It is safe to call multiple times (all statements use IF NOT EXISTS).
func migrateOutbox(db *sql.DB) error {
	_, err := db.Exec(outboxDDL)
	return err
}
