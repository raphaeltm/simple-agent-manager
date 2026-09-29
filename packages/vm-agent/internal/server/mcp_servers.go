package server

import (
	"fmt"
	"log/slog"
	"strings"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/persistence"
)

func normalizeMcpServers(entries []acp.McpServerEntry) ([]acp.McpServerEntry, error) {
	if len(entries) == 0 {
		return nil, nil
	}
	normalized := make([]acp.McpServerEntry, len(entries))
	for i, srv := range entries {
		u := strings.TrimSpace(srv.URL)
		if u == "" {
			return nil, fmt.Errorf("mcpServers[%d].url is required", i)
		}
		// The URL is a SECRET: providers such as Composio issue pre-signed MCP URLs with the
		// credential in the path or query. This error propagates to the control plane, which
		// stores it in tasks.error_message / agent_sessions.error_message — plaintext columns
		// that any project member with task:read (including viewers) can read. So the message
		// must name the index only, never the value.
		isLocalhost := strings.HasPrefix(u, "http://localhost:") || strings.HasPrefix(u, "http://127.0.0.1:")
		if !strings.HasPrefix(u, "https://") && !isLocalhost {
			return nil, fmt.Errorf("mcpServers[%d].url must use HTTPS (or http:// on localhost/127.0.0.1 with an explicit port)", i)
		}
		// Every field must be copied explicitly: this rebuilds the struct, so a field added
		// upstream and forgotten here is silently dropped rather than failing to compile.
		normalized[i] = acp.McpServerEntry{URL: u, Token: srv.Token, Name: strings.TrimSpace(srv.Name)}
	}
	return normalized, nil
}

func (s *Server) registerSessionMcpServers(workspaceID, sessionID string, entries []acp.McpServerEntry) {
	if len(entries) == 0 {
		return
	}

	hostKey := workspaceID + ":" + sessionID
	s.sessionHostMu.Lock()
	s.sessionMcpServers[hostKey] = entries
	s.sessionHostMu.Unlock()

	// Persist to SQLite so MCP servers survive VM agent restarts and
	// are available even if a WebSocket creates the SessionHost first.
	if s.store != nil {
		persistEntries := make([]persistence.McpServer, len(entries))
		for i, srv := range entries {
			persistEntries[i] = persistence.McpServer{URL: srv.URL, Token: srv.Token, Name: srv.Name}
		}
		if err := s.store.UpsertSessionMcpServers(workspaceID, sessionID, persistEntries); err != nil {
			slog.Warn("Failed to persist MCP servers to SQLite",
				"workspace", workspaceID, "session", sessionID, "error", err)
		}
	}

	slog.Info("MCP servers registered for agent session",
		"workspace", workspaceID, "session", sessionID, "count", len(entries))
}
