package messagereport

import (
	"database/sql"
	"fmt"

	"github.com/google/uuid"
)

// The identity belongs to the database, not to a process, session or credential.
// Reopening an outbox must retain it; recreating the database must replace it
// because its AUTOINCREMENT sequence starts over. Old Workers ignore the header.
const outboxIncarnationHeader = "X-SAM-Outbox-Incarnation"

func loadOutboxIncarnation(db *sql.DB) (string, error) {
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS message_outbox_identity (
		id INTEGER PRIMARY KEY CHECK (id = 1), incarnation TEXT NOT NULL
	)`); err != nil {
		return "", fmt.Errorf("create outbox identity: %w", err)
	}
	// Competing constructors converge on the single stored value, including when
	// an older database acquires this additive metadata for the first time.
	if _, err := db.Exec(`INSERT OR IGNORE INTO message_outbox_identity (id, incarnation) VALUES (1, ?)`, uuid.NewString()); err != nil {
		return "", fmt.Errorf("initialize outbox identity: %w", err)
	}
	var incarnation string
	if err := db.QueryRow(`SELECT incarnation FROM message_outbox_identity WHERE id = 1`).Scan(&incarnation); err != nil {
		return "", fmt.Errorf("read outbox identity: %w", err)
	}
	if _, err := uuid.Parse(incarnation); err != nil {
		return "", fmt.Errorf("invalid stored outbox identity: %w", err)
	}
	return incarnation, nil
}
