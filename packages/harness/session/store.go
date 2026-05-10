package session

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/workspace/harness/llm"

	_ "modernc.org/sqlite"
)

// Store provides SQLite-backed session and message persistence.
type Store struct {
	db *sql.DB
}

// NewStore opens (or creates) a SQLite database at dbPath and runs migrations.
func NewStore(dbPath string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, fmt.Errorf("session: create db directory: %w", err)
	}

	db, err := sql.Open("sqlite", dbPath+"?_pragma=journal_mode(wal)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, fmt.Errorf("session: open db: %w", err)
	}

	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("session: migrate: %w", err)
	}

	return &Store{db: db}, nil
}

// Close closes the underlying database connection.
func (s *Store) Close() error {
	return s.db.Close()
}

// CreateSession persists a new session and returns it.
func (s *Store) CreateSession(id string, cfg SessionConfig) (*Session, error) {
	now := time.Now().UTC()
	cfgJSON, err := json.Marshal(cfg)
	if err != nil {
		return nil, fmt.Errorf("session: marshal config: %w", err)
	}

	_, err = s.db.Exec(
		`INSERT INTO sessions (id, created_at, updated_at, status, config)
		 VALUES (?, ?, ?, ?, ?)`,
		id, now.UnixMilli(), now.UnixMilli(), StatusActive, string(cfgJSON),
	)
	if err != nil {
		return nil, fmt.Errorf("session: insert session: %w", err)
	}

	return &Session{
		ID:        id,
		CreatedAt: now,
		UpdatedAt: now,
		Status:    StatusActive,
		Config:    cfg,
	}, nil
}

// LoadSession retrieves a session by ID.
func (s *Store) LoadSession(id string) (*Session, error) {
	row := s.db.QueryRow(
		`SELECT id, created_at, updated_at, status, config FROM sessions WHERE id = ?`, id,
	)
	return scanSession(row)
}

// ListSessions returns all sessions ordered by most recently updated first.
func (s *Store) ListSessions() ([]SessionSummary, error) {
	rows, err := s.db.Query(`
		SELECT s.id, s.created_at, s.updated_at, s.status, s.config,
		       COUNT(m.id) as message_count
		FROM sessions s
		LEFT JOIN messages m ON m.session_id = s.id
		GROUP BY s.id
		ORDER BY s.updated_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("session: list sessions: %w", err)
	}
	defer rows.Close()

	var summaries []SessionSummary
	for rows.Next() {
		var (
			id        string
			createdMS int64
			updatedMS int64
			status    string
			cfgJSON   string
			msgCount  int
		)
		if err := rows.Scan(&id, &createdMS, &updatedMS, &status, &cfgJSON, &msgCount); err != nil {
			return nil, fmt.Errorf("session: scan summary: %w", err)
		}
		var cfg SessionConfig
		_ = json.Unmarshal([]byte(cfgJSON), &cfg)

		summaries = append(summaries, SessionSummary{
			ID:           id,
			CreatedAt:    time.UnixMilli(createdMS).UTC(),
			UpdatedAt:    time.UnixMilli(updatedMS).UTC(),
			Status:       Status(status),
			MessageCount: msgCount,
			UserPrompt:   cfg.UserPrompt,
		})
	}
	return summaries, rows.Err()
}

// UpdateStatus changes a session's status and updates the updated_at timestamp.
func (s *Store) UpdateStatus(id string, status Status) error {
	now := time.Now().UTC()
	res, err := s.db.Exec(
		`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`,
		status, now.UnixMilli(), id,
	)
	if err != nil {
		return fmt.Errorf("session: update status: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("session: no session found with id %q", id)
	}
	return nil
}

// AppendMessages persists a batch of messages for a session.
// Messages are assigned a turn number for ordering within the session.
func (s *Store) AppendMessages(sessionID string, turn int, messages []llm.Message) error {
	now := time.Now().UTC()

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("session: begin tx: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(`
		INSERT INTO messages (session_id, turn, seq, role, content, tool_calls, tool_result, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("session: prepare insert: %w", err)
	}
	defer stmt.Close()

	for i, msg := range messages {
		var toolCallsJSON, toolResultJSON sql.NullString

		if len(msg.ToolCalls) > 0 {
			b, err := json.Marshal(msg.ToolCalls)
			if err != nil {
				return fmt.Errorf("session: marshal tool_calls: %w", err)
			}
			toolCallsJSON = sql.NullString{String: string(b), Valid: true}
		}

		if msg.ToolResult != nil {
			b, err := json.Marshal(msg.ToolResult)
			if err != nil {
				return fmt.Errorf("session: marshal tool_result: %w", err)
			}
			toolResultJSON = sql.NullString{String: string(b), Valid: true}
		}

		_, err := stmt.Exec(
			sessionID, turn, i,
			string(msg.Role), msg.Content,
			toolCallsJSON, toolResultJSON,
			now.UnixMilli(),
		)
		if err != nil {
			return fmt.Errorf("session: insert message: %w", err)
		}
	}

	// Update session's updated_at timestamp.
	if _, err := tx.Exec(
		`UPDATE sessions SET updated_at = ? WHERE id = ?`, now.UnixMilli(), sessionID,
	); err != nil {
		return fmt.Errorf("session: update session timestamp: %w", err)
	}

	return tx.Commit()
}

// LoadMessages retrieves all messages for a session, ordered by turn and sequence.
func (s *Store) LoadMessages(sessionID string) ([]llm.Message, error) {
	rows, err := s.db.Query(`
		SELECT role, content, tool_calls, tool_result
		FROM messages
		WHERE session_id = ?
		ORDER BY turn ASC, seq ASC`, sessionID)
	if err != nil {
		return nil, fmt.Errorf("session: query messages: %w", err)
	}
	defer rows.Close()

	var messages []llm.Message
	for rows.Next() {
		var (
			role           string
			content        string
			toolCallsJSON  sql.NullString
			toolResultJSON sql.NullString
		)
		if err := rows.Scan(&role, &content, &toolCallsJSON, &toolResultJSON); err != nil {
			return nil, fmt.Errorf("session: scan message: %w", err)
		}

		msg := llm.Message{
			Role:    llm.Role(role),
			Content: content,
		}

		if toolCallsJSON.Valid {
			if err := json.Unmarshal([]byte(toolCallsJSON.String), &msg.ToolCalls); err != nil {
				return nil, fmt.Errorf("session: unmarshal tool_calls: %w", err)
			}
		}

		if toolResultJSON.Valid {
			var tr llm.ToolResult
			if err := json.Unmarshal([]byte(toolResultJSON.String), &tr); err != nil {
				return nil, fmt.Errorf("session: unmarshal tool_result: %w", err)
			}
			msg.ToolResult = &tr
		}

		messages = append(messages, msg)
	}
	return messages, rows.Err()
}

// migrate creates the schema if it doesn't exist.
func migrate(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			id         TEXT PRIMARY KEY,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			status     TEXT NOT NULL DEFAULT 'active',
			config     TEXT NOT NULL DEFAULT '{}'
		);

		CREATE TABLE IF NOT EXISTS messages (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL REFERENCES sessions(id),
			turn       INTEGER NOT NULL,
			seq        INTEGER NOT NULL,
			role       TEXT NOT NULL,
			content    TEXT NOT NULL DEFAULT '',
			tool_calls TEXT,
			tool_result TEXT,
			created_at INTEGER NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_messages_session_order
			ON messages(session_id, turn, seq);
	`)
	return err
}

// scanSession scans a single session row.
func scanSession(row *sql.Row) (*Session, error) {
	var (
		id        string
		createdMS int64
		updatedMS int64
		status    string
		cfgJSON   string
	)
	if err := row.Scan(&id, &createdMS, &updatedMS, &status, &cfgJSON); err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("session: not found")
		}
		return nil, fmt.Errorf("session: scan: %w", err)
	}

	var cfg SessionConfig
	_ = json.Unmarshal([]byte(cfgJSON), &cfg)

	return &Session{
		ID:        id,
		CreatedAt: time.UnixMilli(createdMS).UTC(),
		UpdatedAt: time.UnixMilli(updatedMS).UTC(),
		Status:    Status(status),
		Config:    cfg,
	}, nil
}
