package persistence

import (
	"strings"
	"testing"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(tempDBPath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

func TestSessionMcpServerHeadersRoundTrip(t *testing.T) {
	store := openTestStore(t)

	servers := []McpServer{
		{URL: "https://api.example.com/mcp", Token: "sam-token", Name: "sam-mcp"},
		{
			URL:  "https://backend.composio.dev/mcp",
			Name: "composio",
			Headers: []McpServerHeader{
				{Name: "x-api-key", Value: "ak_live_secret"},
				{Name: "X-Org_Id", Value: "org-42"},
			},
		},
	}
	if err := store.UpsertSessionMcpServers("ws-1", "sess-1", servers); err != nil {
		t.Fatalf("UpsertSessionMcpServers: %v", err)
	}

	got, err := store.GetSessionMcpServers("ws-1", "sess-1")
	if err != nil {
		t.Fatalf("GetSessionMcpServers: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 servers, got %d", len(got))
	}
	if len(got[0].Headers) != 0 {
		t.Errorf("server without headers read back %#v", got[0].Headers)
	}
	if len(got[1].Headers) != 2 || got[1].Headers[0] != servers[1].Headers[0] || got[1].Headers[1] != servers[1].Headers[1] {
		t.Errorf("headers = %#v, want %#v in order", got[1].Headers, servers[1].Headers)
	}

	// "No headers" is stored as the column default, not "[]" or "null", so a server without
	// headers is indistinguishable from a row written before the column existed.
	var raw string
	if err := store.db.QueryRow(
		"SELECT headers FROM session_mcp_servers WHERE session_id = ? AND sort_order = 0", "sess-1",
	).Scan(&raw); err != nil {
		t.Fatalf("read raw headers column: %v", err)
	}
	if raw != "" {
		t.Errorf("headerless server stored %q, want the empty column default", raw)
	}
}

// A vm-agent upgraded across migrateV18 holds session rows written without a headers column.
// They must read back exactly as they were — same server, no headers — not fail the read,
// because a failed read leaves a restarted session with no MCP servers at all.
func TestMigrationV18KeepsExistingMcpServerRows(t *testing.T) {
	dbPath := tempDBPath(t)
	store, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	// Rewind the database to its pre-V18 shape and write a row the old agent would have.
	for _, stmt := range []string{
		"ALTER TABLE session_mcp_servers DROP COLUMN headers",
		"DELETE FROM schema_version WHERE version = 18",
		"INSERT INTO session_mcp_servers (workspace_id, session_id, sort_order, url, token, name) " +
			"VALUES ('ws-1', 'sess-1', 0, 'https://mcp.zapier.com/x', 'zap-token', 'zapier')",
	} {
		if _, err := store.db.Exec(stmt); err != nil {
			t.Fatalf("rewind to V17 (%s): %v", stmt, err)
		}
	}
	store.Close()

	upgraded, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open after rewind (runs migrateV18): %v", err)
	}
	defer upgraded.Close()

	got, err := upgraded.GetSessionMcpServers("ws-1", "sess-1")
	if err != nil {
		t.Fatalf("GetSessionMcpServers on an upgraded row: %v", err)
	}
	if len(got) != 1 || got[0].Name != "zapier" || got[0].Token != "zap-token" {
		t.Fatalf("upgraded row = %#v, want the original zapier server", got)
	}
	if len(got[0].Headers) != 0 {
		t.Errorf("upgraded row gained headers: %#v", got[0].Headers)
	}
}

func TestGetSessionMcpServers_MalformedHeadersFailWithoutLeakingThem(t *testing.T) {
	store := openTestStore(t)
	const secret = "ak_live_secret"
	if _, err := store.db.Exec(
		"INSERT INTO session_mcp_servers (workspace_id, session_id, sort_order, url, token, name, headers) "+
			"VALUES ('ws-1', 'sess-1', 0, 'https://backend.composio.dev/mcp', '', 'composio', ?)",
		`[{"name":"x-api-key","value":"`+secret+`"`, // truncated JSON
	); err != nil {
		t.Fatalf("insert malformed row: %v", err)
	}

	_, err := store.GetSessionMcpServers("ws-1", "sess-1")
	if err == nil {
		t.Fatal("expected a malformed headers column to fail the read")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("error leaks the stored header value: %v", err)
	}
}
