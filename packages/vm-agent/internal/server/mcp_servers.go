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
		// Header values reach TOML files and mcp-remote arguments, so a malformed header fails
		// the request here, like a malformed URL, rather than being written out.
		if err := acp.ValidateMcpHeaders(srv.Headers); err != nil {
			return nil, fmt.Errorf("mcpServers[%d]: %w", i, err)
		}
		// Every field must be copied explicitly: this rebuilds the struct, so a field added
		// upstream and forgotten here is silently dropped rather than failing to compile.
		normalized[i] = acp.McpServerEntry{
			URL:     u,
			Token:   srv.Token,
			Name:    strings.TrimSpace(srv.Name),
			Headers: srv.Headers,
		}
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
		if err := s.store.UpsertSessionMcpServers(workspaceID, sessionID, toPersistedMcpServers(entries)); err != nil {
			slog.Warn("Failed to persist MCP servers to SQLite",
				"workspace", workspaceID, "session", sessionID, "error", err)
		}
	}

	slog.Info("MCP servers registered for agent session",
		"workspace", workspaceID, "session", sessionID, "count", len(entries))
}

// toPersistedMcpServers and fromPersistedMcpServers are the only conversions between the acp
// and persistence shapes. Both rebuild structs field by field, so a field added to one side and
// not copied here is silently dropped. TestMcpServerNameSurvivesFullRoundTrip and
// TestMcpServerHeadersSurviveFullRoundTrip guard that.
func toPersistedMcpServers(entries []acp.McpServerEntry) []persistence.McpServer {
	servers := make([]persistence.McpServer, len(entries))
	for i, entry := range entries {
		headers := make([]persistence.McpServerHeader, len(entry.Headers))
		for j, header := range entry.Headers {
			headers[j] = persistence.McpServerHeader{Name: header.Name, Value: header.Value}
		}
		servers[i] = persistence.McpServer{URL: entry.URL, Token: entry.Token, Name: entry.Name, Headers: headers}
	}
	return servers
}

func fromPersistedMcpServers(servers []persistence.McpServer) []acp.McpServerEntry {
	entries := make([]acp.McpServerEntry, len(servers))
	for i, server := range servers {
		headers := make([]acp.McpHeader, len(server.Headers))
		for j, header := range server.Headers {
			headers[j] = acp.McpHeader{Name: header.Name, Value: header.Value}
		}
		entries[i] = acp.McpServerEntry{URL: server.URL, Token: server.Token, Name: server.Name, Headers: headers}
	}
	return entries
}
