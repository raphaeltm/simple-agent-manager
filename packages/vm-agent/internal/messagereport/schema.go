package messagereport

import (
	"database/sql"
	"strings"
)

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
	last_attempt_at TEXT,
	origin          TEXT
);

CREATE INDEX IF NOT EXISTS idx_message_outbox_created
	ON message_outbox(created_at);
`

// migrateOutbox creates the message_outbox table if it does not already exist
// and applies additive column migrations. It is safe to call multiple times.
func migrateOutbox(db *sql.DB) error {
	if _, err := db.Exec(outboxDDL); err != nil {
		return err
	}
	// Additive migration for outbox DBs created before the `origin` column
	// existed (e.g. a warm node reusing an on-disk outbox). SQLite has no
	// "ADD COLUMN IF NOT EXISTS"; a duplicate-column error is benign and ignored.
	if _, err := db.Exec(`ALTER TABLE message_outbox ADD COLUMN origin TEXT`); err != nil &&
		!strings.Contains(err.Error(), "duplicate column name") {
		return err
	}
	return nil
}
