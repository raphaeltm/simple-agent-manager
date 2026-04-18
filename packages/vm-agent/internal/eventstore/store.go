// Package eventstore provides SQLite-backed persistent event storage for the VM agent.
// Replaces the in-memory event slices with durable storage that survives agent restarts
// and can be downloaded as a raw SQLite file for debugging.
package eventstore

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// EventRecord is a structured event emitted by the VM agent.
type EventRecord struct {
	ID          string                 `json:"id"`
	NodeID      string                 `json:"nodeId,omitempty"`
	WorkspaceID string                 `json:"workspaceId,omitempty"`
	Level       string                 `json:"level"`
	Type        string                 `json:"type"`
	Message     string                 `json:"message"`
	Detail      map[string]interface{} `json:"detail,omitempty"`
	CreatedAt   string                 `json:"createdAt"`
}

// Store is a SQLite-backed event store.
type Store struct {
	db     *sql.DB
	dbPath string
	mu     sync.Mutex // serializes writes
}

// New opens (or creates) a SQLite event store at the given path.
func New(dbPath string) (*Store, error) {
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?cache=shared&mode=rwc&_journal_mode=WAL", dbPath))
	if err != nil {
		return nil, fmt.Errorf("eventstore: open: %w", err)
	}
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA busy_timeout=5000",
		"PRAGMA synchronous=NORMAL",
	} {
		if _, err := db.Exec(pragma); err != nil {
			db.Close()
			return nil, fmt.Errorf("eventstore: %s: %w", pragma, err)
		}
	}

	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("eventstore: migrate: %w", err)
	}

	s := &Store{db: db, dbPath: dbPath}

	// Trim old events on startup (keep last 7 days).
	if n, err := s.trimOlderThan(7 * 24 * time.Hour); err != nil {
		slog.Warn("eventstore: trim on startup failed", "error", err)
	} else if n > 0 {
		slog.Info("eventstore: trimmed old events on startup", "deleted", n)
	}

	return s, nil
}

func migrate(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS events (
			id          TEXT PRIMARY KEY,
			node_id     TEXT NOT NULL DEFAULT '',
			workspace_id TEXT NOT NULL DEFAULT '',
			level       TEXT NOT NULL DEFAULT 'info',
			type        TEXT NOT NULL DEFAULT '',
			message     TEXT NOT NULL DEFAULT '',
			detail      TEXT,
			created_at  TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
		CREATE INDEX IF NOT EXISTS idx_events_workspace ON events(workspace_id, created_at);
		CREATE INDEX IF NOT EXISTS idx_events_level ON events(level, created_at);
		CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(type, created_at);
	`)
	return err
}

// Append inserts an event into the store.
func (s *Store) Append(e EventRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var detailJSON []byte
	if e.Detail != nil {
		detailJSON, _ = json.Marshal(e.Detail)
	}

	_, err := s.db.Exec(
		`INSERT OR IGNORE INTO events (id, node_id, workspace_id, level, type, message, detail, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		e.ID, e.NodeID, e.WorkspaceID, e.Level, e.Type, e.Message, string(detailJSON), e.CreatedAt,
	)
	if err != nil {
		slog.Error("eventstore: insert failed", "error", err, "eventId", e.ID)
	}
}

// ListNode returns the most recent node-level events (all workspaces), newest first.
func (s *Store) ListNode(limit int) ([]EventRecord, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.db.Query(
		`SELECT id, node_id, workspace_id, level, type, message, detail, created_at
		 FROM events ORDER BY created_at DESC LIMIT ?`, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanEvents(rows)
}

// ListWorkspace returns events for a specific workspace, newest first.
func (s *Store) ListWorkspace(workspaceID string, limit int) ([]EventRecord, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.db.Query(
		`SELECT id, node_id, workspace_id, level, type, message, detail, created_at
		 FROM events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`,
		workspaceID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanEvents(rows)
}

// ListByTypePrefix returns events whose type starts with the given prefix, oldest first.
// Used by the debug package to surface provisioning step timings in chronological order.
func (s *Store) ListByTypePrefix(prefix string, limit int) ([]EventRecord, error) {
	if limit <= 0 {
		limit = 1000
	}
	rows, err := s.db.Query(
		`SELECT id, node_id, workspace_id, level, type, message, detail, created_at
		 FROM events WHERE type LIKE ? ORDER BY created_at ASC LIMIT ?`,
		prefix+"%", limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanEvents(rows)
}

func scanEvents(rows *sql.Rows) ([]EventRecord, error) {
	var events []EventRecord
	for rows.Next() {
		var e EventRecord
		var detailStr sql.NullString
		if err := rows.Scan(&e.ID, &e.NodeID, &e.WorkspaceID, &e.Level, &e.Type, &e.Message, &detailStr, &e.CreatedAt); err != nil {
			return nil, err
		}
		if detailStr.Valid && detailStr.String != "" {
			_ = json.Unmarshal([]byte(detailStr.String), &e.Detail)
		}
		events = append(events, e)
	}
	return events, rows.Err()
}

// trimOlderThan deletes events older than the given duration.
func (s *Store) trimOlderThan(d time.Duration) (int64, error) {
	cutoff := time.Now().UTC().Add(-d).Format(time.RFC3339)
	result, err := s.db.Exec(`DELETE FROM events WHERE created_at < ?`, cutoff)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// Checkpoint forces a WAL checkpoint so the main database file contains all data.
// Must be called before serving the database file for download.
func (s *Store) Checkpoint() error {
	_, err := s.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
	return err
}

// DBPath returns the filesystem path to the SQLite database file.
func (s *Store) DBPath() string {
	return s.dbPath
}

// Close closes the underlying database connection.
func (s *Store) Close() error {
	return s.db.Close()
}
