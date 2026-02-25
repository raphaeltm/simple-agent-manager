// Package persistence provides SQLite-backed session state persistence
// for cross-device "pick up where you left off" functionality.
package persistence

import (
	"database/sql"
	"fmt"
	"log/slog"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// WorkspaceMetadata represents persisted workspace metadata that survives
// agent restarts. This ensures the correct container working directory,
// repository name, and other runtime state can be recovered without
// re-fetching from the control plane.
type WorkspaceMetadata struct {
	WorkspaceID       string `json:"workspaceId"`
	Repository        string `json:"repository"`
	Branch            string `json:"branch"`
	ContainerWorkDir  string `json:"containerWorkDir"`
	ContainerUser     string `json:"containerUser"`
	ContainerLabelVal string `json:"containerLabelValue"`
	WorkspaceDir      string `json:"workspaceDir"`
	UpdatedAt         string `json:"updatedAt"`
}

// Tab represents a persisted tab (terminal or chat session).
type Tab struct {
	ID           string `json:"id"`
	WorkspaceID  string `json:"workspaceId"`
	Type         string `json:"type"`    // "terminal" or "chat"
	Label        string `json:"label"`   // Display name
	AgentID      string `json:"agentId"` // Agent type for chat tabs (empty for terminals)
	SortOrder    int    `json:"sortOrder"`
	CreatedAt    string `json:"createdAt"`    // ISO 8601
	AcpSessionID string `json:"acpSessionId"` // ACP session ID for LoadSession on reconnect
	LastPrompt   string `json:"lastPrompt"`   // Last user message for session discoverability
}

// Store provides persistent session state backed by SQLite.
type Store struct {
	db *sql.DB
	mu sync.RWMutex
}

// Open creates or opens a SQLite database at the given path.
func Open(dbPath string) (*Store, error) {
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?cache=shared&mode=rwc&_journal_mode=WAL", dbPath))
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}

	// SQLite tuning for write-heavy workloads
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		db.Close()
		return nil, fmt.Errorf("set WAL mode: %w", err)
	}
	if _, err := db.Exec("PRAGMA busy_timeout=5000"); err != nil {
		db.Close()
		return nil, fmt.Errorf("set busy timeout: %w", err)
	}

	store := &Store{db: db}
	if err := store.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}

	return store, nil
}

// Close closes the database.
func (s *Store) Close() error {
	return s.db.Close()
}

// migrate applies schema migrations.
func (s *Store) migrate() error {
	// Create schema_version table if not exists
	if _, err := s.db.Exec(`
		CREATE TABLE IF NOT EXISTS schema_version (
			version INTEGER NOT NULL
		)
	`); err != nil {
		return fmt.Errorf("create schema_version table: %w", err)
	}

	// Get current version
	var version int
	err := s.db.QueryRow("SELECT COALESCE(MAX(version), 0) FROM schema_version").Scan(&version)
	if err != nil {
		return fmt.Errorf("get schema version: %w", err)
	}

	migrations := []func(*sql.DB) error{
		migrateV1,
		migrateV2,
		migrateV3,
		migrateV4,
	}

	for i := version; i < len(migrations); i++ {
		slog.Info("Applying persistence migration", "version", i+1)
		if err := migrations[i](s.db); err != nil {
			return fmt.Errorf("migration v%d: %w", i+1, err)
		}
		if _, err := s.db.Exec("INSERT INTO schema_version (version) VALUES (?)", i+1); err != nil {
			return fmt.Errorf("record migration v%d: %w", i+1, err)
		}
	}

	return nil
}

// migrateV1 creates the initial tabs table.
func migrateV1(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS tabs (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			type TEXT NOT NULL,
			label TEXT NOT NULL DEFAULT '',
			agent_id TEXT NOT NULL DEFAULT '',
			sort_order INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_tabs_workspace ON tabs(workspace_id);
	`)
	return err
}

// migrateV2 adds acp_session_id column for LoadSession reconnection support.
func migrateV2(db *sql.DB) error {
	_, err := db.Exec(`ALTER TABLE tabs ADD COLUMN acp_session_id TEXT NOT NULL DEFAULT ''`)
	return err
}

// migrateV3 adds last_prompt column for session discoverability in history UI.
func migrateV3(db *sql.DB) error {
	_, err := db.Exec(`ALTER TABLE tabs ADD COLUMN last_prompt TEXT NOT NULL DEFAULT ''`)
	return err
}

// migrateV4 creates the workspace_metadata table for persisting workspace
// runtime state (repository, container work dir, etc.) across agent restarts.
func migrateV4(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS workspace_metadata (
			workspace_id TEXT PRIMARY KEY,
			repository TEXT NOT NULL DEFAULT '',
			branch TEXT NOT NULL DEFAULT '',
			container_work_dir TEXT NOT NULL DEFAULT '',
			container_user TEXT NOT NULL DEFAULT '',
			container_label_value TEXT NOT NULL DEFAULT '',
			workspace_dir TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL
		)
	`)
	return err
}

// UpsertWorkspaceMetadata persists workspace metadata to SQLite.
// Called when a workspace is created or its runtime state is updated with
// meaningful values (non-empty repository, container work dir, etc.).
func (s *Store) UpsertWorkspaceMetadata(meta WorkspaceMetadata) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if meta.UpdatedAt == "" {
		meta.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	}

	_, err := s.db.Exec(
		`INSERT OR REPLACE INTO workspace_metadata
			(workspace_id, repository, branch, container_work_dir, container_user, container_label_value, workspace_dir, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		meta.WorkspaceID, meta.Repository, meta.Branch, meta.ContainerWorkDir,
		meta.ContainerUser, meta.ContainerLabelVal, meta.WorkspaceDir, meta.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("upsert workspace metadata: %w", err)
	}
	return nil
}

// GetWorkspaceMetadata retrieves persisted workspace metadata.
// Returns nil, nil if no metadata exists for the given workspace ID.
func (s *Store) GetWorkspaceMetadata(workspaceID string) (*WorkspaceMetadata, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var m WorkspaceMetadata
	err := s.db.QueryRow(
		`SELECT workspace_id, repository, branch, container_work_dir, container_user, container_label_value, workspace_dir, updated_at
		FROM workspace_metadata WHERE workspace_id = ?`,
		workspaceID,
	).Scan(&m.WorkspaceID, &m.Repository, &m.Branch, &m.ContainerWorkDir,
		&m.ContainerUser, &m.ContainerLabelVal, &m.WorkspaceDir, &m.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get workspace metadata: %w", err)
	}
	return &m, nil
}

// DeleteWorkspaceMetadata removes persisted metadata for a workspace.
func (s *Store) DeleteWorkspaceMetadata(workspaceID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec("DELETE FROM workspace_metadata WHERE workspace_id = ?", workspaceID)
	if err != nil {
		return fmt.Errorf("delete workspace metadata: %w", err)
	}
	return nil
}

// InsertTab adds a new tab to the store.
func (s *Store) InsertTab(tab Tab) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if tab.CreatedAt == "" {
		tab.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	}

	_, err := s.db.Exec(
		"INSERT OR REPLACE INTO tabs (id, workspace_id, type, label, agent_id, sort_order, created_at, acp_session_id, last_prompt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		tab.ID, tab.WorkspaceID, tab.Type, tab.Label, tab.AgentID, tab.SortOrder, tab.CreatedAt, tab.AcpSessionID, tab.LastPrompt,
	)
	if err != nil {
		return fmt.Errorf("insert tab: %w", err)
	}
	return nil
}

// DeleteTab removes a tab from the store.
func (s *Store) DeleteTab(tabID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec("DELETE FROM tabs WHERE id = ?", tabID)
	if err != nil {
		return fmt.Errorf("delete tab: %w", err)
	}
	return nil
}

// ListTabs returns all tabs for a workspace, ordered by sort_order then created_at.
func (s *Store) ListTabs(workspaceID string) ([]Tab, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rows, err := s.db.Query(
		"SELECT id, workspace_id, type, label, agent_id, sort_order, created_at, acp_session_id, last_prompt FROM tabs WHERE workspace_id = ? ORDER BY sort_order ASC, created_at ASC",
		workspaceID,
	)
	if err != nil {
		return nil, fmt.Errorf("list tabs: %w", err)
	}
	defer rows.Close()

	var tabs []Tab
	for rows.Next() {
		var t Tab
		if err := rows.Scan(&t.ID, &t.WorkspaceID, &t.Type, &t.Label, &t.AgentID, &t.SortOrder, &t.CreatedAt, &t.AcpSessionID, &t.LastPrompt); err != nil {
			return nil, fmt.Errorf("scan tab: %w", err)
		}
		tabs = append(tabs, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate tabs: %w", err)
	}

	if tabs == nil {
		tabs = []Tab{}
	}
	return tabs, nil
}

// DeleteWorkspaceTabs removes all tabs for a workspace.
func (s *Store) DeleteWorkspaceTabs(workspaceID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec("DELETE FROM tabs WHERE workspace_id = ?", workspaceID)
	if err != nil {
		return fmt.Errorf("delete workspace tabs: %w", err)
	}
	return nil
}

// UpdateTabLabel updates the label of a tab.
func (s *Store) UpdateTabLabel(tabID, label string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec("UPDATE tabs SET label = ? WHERE id = ?", label, tabID)
	if err != nil {
		return fmt.Errorf("update tab label: %w", err)
	}
	return nil
}

// UpdateTabOrder updates the sort order of a tab.
func (s *Store) UpdateTabOrder(tabID string, sortOrder int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec("UPDATE tabs SET sort_order = ? WHERE id = ?", sortOrder, tabID)
	if err != nil {
		return fmt.Errorf("update tab order: %w", err)
	}
	return nil
}

// UpdateTabLastPrompt updates the last user message for a tab.
// Called during HandlePrompt to capture the prompt text for session discoverability.
func (s *Store) UpdateTabLastPrompt(tabID, lastPrompt string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec("UPDATE tabs SET last_prompt = ? WHERE id = ?", lastPrompt, tabID)
	if err != nil {
		return fmt.Errorf("update tab last prompt: %w", err)
	}
	return nil
}

// UpdateTabAcpSessionID updates the ACP session ID for a tab.
// Called after a successful NewSession or LoadSession to persist the ACP session ID
// for reconnection with LoadSession.
func (s *Store) UpdateTabAcpSessionID(tabID, acpSessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec("UPDATE tabs SET acp_session_id = ? WHERE id = ?", acpSessionID, tabID)
	if err != nil {
		return fmt.Errorf("update tab acp session id: %w", err)
	}
	return nil
}

// TabCount returns the number of tabs for a workspace.
func (s *Store) TabCount(workspaceID string) (int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var count int
	err := s.db.QueryRow("SELECT COUNT(*) FROM tabs WHERE workspace_id = ?", workspaceID).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count tabs: %w", err)
	}
	return count, nil
}
