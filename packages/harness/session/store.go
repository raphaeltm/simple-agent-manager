package session

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/workspace/harness/features"
	"github.com/workspace/harness/llm"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    system_prompt TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    work_dir TEXT,
    model TEXT,
    total_turns INTEGER DEFAULT 0,
    feature_state TEXT
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    turn INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    tool_calls TEXT,
    tool_result TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, turn);
`

// Store provides SQLite-backed session persistence.
type Store struct {
	db *sql.DB
}

// NewStore opens (or creates) a SQLite database at dbPath and runs migrations.
func NewStore(dbPath string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, fmt.Errorf("session: create db directory: %w", err)
	}

	db, err := sql.Open("sqlite", dbPath+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, fmt.Errorf("session: open database: %w", err)
	}

	// Serialize writes to avoid SQLITE_BUSY with pure-Go SQLite.
	db.SetMaxOpenConns(1)

	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("session: run migrations: %w", err)
	}
	if err := ensureFeatureStateColumn(db); err != nil {
		db.Close()
		return nil, err
	}

	return &Store{db: db}, nil
}

// CreateSession creates a new session record and returns it.
func (s *Store) CreateSession(id string, cfg Config) (*Session, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := s.db.Exec(
		`INSERT INTO sessions (id, created_at, updated_at, system_prompt, status, work_dir, model, total_turns)
		 VALUES (?, ?, ?, ?, 'active', ?, ?, 0)`,
		id, now, now, cfg.SystemPrompt, cfg.WorkDir, cfg.Model,
	)
	if err != nil {
		return nil, fmt.Errorf("session: create: %w", err)
	}

	return s.LoadSession(id)
}

// LoadSession retrieves a session by ID.
func (s *Store) LoadSession(id string) (*Session, error) {
	row := s.db.QueryRow(
		`SELECT id, created_at, updated_at, system_prompt, status, work_dir, model, total_turns
		 FROM sessions WHERE id = ?`, id,
	)
	var sess Session
	var createdAt, updatedAt string
	var sysPrompt, workDir, model sql.NullString
	err := row.Scan(&sess.ID, &createdAt, &updatedAt, &sysPrompt, &sess.Status, &workDir, &model, &sess.TotalTurns)
	if err != nil {
		return nil, fmt.Errorf("session: load %q: %w", id, err)
	}
	sess.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	sess.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
	sess.SystemPrompt = sysPrompt.String
	sess.WorkDir = workDir.String
	sess.Model = model.String
	return &sess, nil
}

// ListSessions returns the most recent sessions.
func (s *Store) ListSessions(limit int) ([]Summary, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := s.db.Query(
		`SELECT id, created_at, status, total_turns FROM sessions ORDER BY rowid DESC LIMIT ?`, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("session: list: %w", err)
	}
	defer rows.Close()

	var out []Summary
	for rows.Next() {
		var sum Summary
		var createdAt string
		if err := rows.Scan(&sum.ID, &createdAt, &sum.Status, &sum.TotalTurns); err != nil {
			return nil, fmt.Errorf("session: list scan: %w", err)
		}
		sum.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
		out = append(out, sum)
	}
	return out, rows.Err()
}

// AppendMessages persists messages for a given session and turn.
func (s *Store) AppendMessages(sessionID string, turn int, msgs []llm.Message) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("session: begin tx: %w", err)
	}
	defer tx.Rollback()

	now := time.Now().UTC().Format(time.RFC3339)
	stmt, err := tx.Prepare(
		`INSERT INTO messages (session_id, turn, role, content, tool_calls, tool_result, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("session: prepare insert: %w", err)
	}
	defer stmt.Close()

	for _, m := range msgs {
		var toolCallsJSON, toolResultJSON sql.NullString

		if len(m.ToolCalls) > 0 {
			data, _ := json.Marshal(m.ToolCalls)
			toolCallsJSON = sql.NullString{String: string(data), Valid: true}
		}
		if m.ToolResult != nil {
			data, _ := json.Marshal(m.ToolResult)
			toolResultJSON = sql.NullString{String: string(data), Valid: true}
		}

		if _, err := stmt.Exec(sessionID, turn, string(m.Role), m.Content, toolCallsJSON, toolResultJSON, now); err != nil {
			return fmt.Errorf("session: insert message: %w", err)
		}
	}

	// Update session metadata.
	if _, err := tx.Exec(
		`UPDATE sessions SET updated_at = ?, total_turns = ? WHERE id = ?`,
		now, turn, sessionID,
	); err != nil {
		return fmt.Errorf("session: update session: %w", err)
	}

	return tx.Commit()
}

// LoadMessages retrieves all messages for a session in turn order.
func (s *Store) LoadMessages(sessionID string) ([]llm.Message, error) {
	rows, err := s.db.Query(
		`SELECT role, content, tool_calls, tool_result FROM messages
		 WHERE session_id = ? ORDER BY id ASC`, sessionID,
	)
	if err != nil {
		return nil, fmt.Errorf("session: load messages: %w", err)
	}
	defer rows.Close()

	var out []llm.Message
	for rows.Next() {
		var role, content string
		var toolCallsJSON, toolResultJSON sql.NullString
		if err := rows.Scan(&role, &content, &toolCallsJSON, &toolResultJSON); err != nil {
			return nil, fmt.Errorf("session: scan message: %w", err)
		}

		m := llm.Message{
			Role:    llm.Role(role),
			Content: content,
		}
		if toolCallsJSON.Valid {
			_ = json.Unmarshal([]byte(toolCallsJSON.String), &m.ToolCalls)
		}
		if toolResultJSON.Valid {
			var tr llm.ToolResult
			if json.Unmarshal([]byte(toolResultJSON.String), &tr) == nil {
				m.ToolResult = &tr
			}
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// UpdateStatus sets the session status (active, completed, abandoned).
func (s *Store) UpdateStatus(sessionID, status string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := s.db.Exec(
		`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`,
		status, now, sessionID,
	)
	if err != nil {
		return fmt.Errorf("session: update status: %w", err)
	}
	return nil
}

// SaveFeatures stores the current harness-owned feature state for a session.
func (s *Store) SaveFeatures(sessionID string, list *features.List) error {
	if list == nil {
		return nil
	}
	data, err := list.MarshalJSON()
	if err != nil {
		return fmt.Errorf("session: marshal features: %w", err)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := s.db.Exec(
		`UPDATE sessions SET feature_state = ?, updated_at = ? WHERE id = ?`,
		string(data), now, sessionID,
	); err != nil {
		return fmt.Errorf("session: save features: %w", err)
	}
	return nil
}

// LoadFeatures retrieves persisted feature state for a session.
func (s *Store) LoadFeatures(sessionID string) (*features.List, error) {
	row := s.db.QueryRow(`SELECT feature_state FROM sessions WHERE id = ?`, sessionID)
	var raw sql.NullString
	if err := row.Scan(&raw); err != nil {
		return nil, fmt.Errorf("session: load features %q: %w", sessionID, err)
	}
	if !raw.Valid || raw.String == "" {
		return nil, nil
	}
	list, err := features.FromJSON([]byte(raw.String))
	if err != nil {
		return nil, fmt.Errorf("session: parse features %q: %w", sessionID, err)
	}
	return list, nil
}

// Close closes the underlying database connection.
func (s *Store) Close() error {
	return s.db.Close()
}

func ensureFeatureStateColumn(db *sql.DB) error {
	rows, err := db.Query(`PRAGMA table_info(sessions)`)
	if err != nil {
		return fmt.Errorf("session: inspect schema: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var cid int
		var name, typ string
		var notNull, pk int
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &pk); err != nil {
			return fmt.Errorf("session: scan schema: %w", err)
		}
		if name == "feature_state" {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("session: scan schema: %w", err)
	}
	if _, err := db.Exec(`ALTER TABLE sessions ADD COLUMN feature_state TEXT`); err != nil {
		return fmt.Errorf("session: add feature_state column: %w", err)
	}
	return nil
}
