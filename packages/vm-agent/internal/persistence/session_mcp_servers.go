package persistence

import (
	"database/sql"
	"fmt"
)

// McpServer represents a persisted MCP server config for an ACP session.
// It mirrors acp.McpServerEntry and is stored independently to avoid an
// import cycle between the persistence and acp packages.
type McpServer struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	// Name is the agent-visible server name. Empty for rows written before the
	// name column existed; callers fall back to positional naming.
	Name string `json:"name,omitempty"`
}

// migrateV5 creates the session_mcp_servers table for persisting MCP server
// configs registered per ACP session so they survive VM agent restarts.
func migrateV5(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS session_mcp_servers (
			workspace_id TEXT NOT NULL,
			session_id   TEXT NOT NULL,
			sort_order   INTEGER NOT NULL DEFAULT 0,
			url          TEXT NOT NULL,
			token        TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (workspace_id, session_id, sort_order)
		);
		CREATE INDEX IF NOT EXISTS idx_session_mcp_workspace ON session_mcp_servers(workspace_id);
	`)
	return err
}

// migrateV12 adds the agent-visible name for injected MCP servers.
//
// Additive column with a default so pre-existing rows remain valid: an empty name means
// "unnamed", and acp.ResolveMcpServerNames falls back to the legacy positional scheme for
// those, preserving the behaviour of sessions registered before this column existed.
func migrateV12(db *sql.DB) error {
	_, err := db.Exec(`
		ALTER TABLE session_mcp_servers ADD COLUMN name TEXT NOT NULL DEFAULT '';
	`)
	return err
}

// UpsertSessionMcpServers replaces all MCP server entries for a session.
// Passing an empty slice removes all servers for the session without error.
// This is intentionally a full replace (delete + insert) so that the
// persisted list always exactly mirrors the in-memory sessionMcpServers map.
func (s *Store) UpsertSessionMcpServers(workspaceID, sessionID string, servers []McpServer) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("upsert session mcp servers: begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	if _, err := tx.Exec(
		"DELETE FROM session_mcp_servers WHERE workspace_id = ? AND session_id = ?",
		workspaceID, sessionID,
	); err != nil {
		return fmt.Errorf("upsert session mcp servers: delete old rows: %w", err)
	}

	for i, srv := range servers {
		if _, err := tx.Exec(
			"INSERT INTO session_mcp_servers (workspace_id, session_id, sort_order, url, token, name) VALUES (?, ?, ?, ?, ?, ?)",
			workspaceID, sessionID, i, srv.URL, srv.Token, srv.Name,
		); err != nil {
			return fmt.Errorf("upsert session mcp servers: insert row %d: %w", i, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("upsert session mcp servers: commit: %w", err)
	}
	return nil
}

// GetSessionMcpServers returns the persisted MCP servers for a session,
// ordered by sort_order. Returns an empty (non-nil) slice when none exist.
func (s *Store) GetSessionMcpServers(workspaceID, sessionID string) ([]McpServer, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rows, err := s.db.Query(
		"SELECT url, token, name FROM session_mcp_servers WHERE workspace_id = ? AND session_id = ? ORDER BY sort_order ASC",
		workspaceID, sessionID,
	)
	if err != nil {
		return nil, fmt.Errorf("get session mcp servers: %w", err)
	}
	defer rows.Close()

	servers := []McpServer{}
	for rows.Next() {
		var srv McpServer
		if err := rows.Scan(&srv.URL, &srv.Token, &srv.Name); err != nil {
			return nil, fmt.Errorf("get session mcp servers: scan: %w", err)
		}
		servers = append(servers, srv)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("get session mcp servers: iterate: %w", err)
	}
	return servers, nil
}

// DeleteSessionMcpServers removes all MCP server entries for a specific
// session. It is a no-op when no entries exist.
func (s *Store) DeleteSessionMcpServers(workspaceID, sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		"DELETE FROM session_mcp_servers WHERE workspace_id = ? AND session_id = ?",
		workspaceID, sessionID,
	)
	if err != nil {
		return fmt.Errorf("delete session mcp servers: %w", err)
	}
	return nil
}

// DeleteWorkspaceMcpServers removes all MCP server entries for every session
// belonging to the given workspace. Called during workspace cleanup.
func (s *Store) DeleteWorkspaceMcpServers(workspaceID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		"DELETE FROM session_mcp_servers WHERE workspace_id = ?",
		workspaceID,
	)
	if err != nil {
		return fmt.Errorf("delete workspace mcp servers: %w", err)
	}
	return nil
}
