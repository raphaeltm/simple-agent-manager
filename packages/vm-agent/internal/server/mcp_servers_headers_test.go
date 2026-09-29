package server

import (
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
)

// TestMcpServerHeadersSurviveFullRoundTrip drives custom headers through all three field-by-
// field conversions an MCP entry passes through — normalizeMcpServers, acp -> persistence, and
// the restart backfill persistence -> acp — then asserts the SessionHost would receive them.
// A conversion that forgets the field compiles fine and drops the header silently, which for
// Composio means every tool call fails authentication.
func TestMcpServerHeadersSurviveFullRoundTrip(t *testing.T) {
	s, store := newMcpTestServer(t)

	wantHeaders := []acp.McpHeader{
		{Name: "x-api-key", Value: "ak_live_secret"},
		{Name: "X-Org_Id", Value: "org-42"},
	}
	entries, err := normalizeMcpServers([]acp.McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "sam-token", Name: acp.SamMcpServerName},
		{URL: "https://backend.composio.dev/v3/mcp/x", Name: "composio", Headers: wantHeaders},
	})
	if err != nil {
		t.Fatalf("normalizeMcpServers: %v", err)
	}
	assertHeaders(t, "normalizeMcpServers", entries[1].Headers, wantHeaders)
	if len(entries[0].Headers) != 0 {
		t.Errorf("sam-mcp gained headers during normalization: %#v", entries[0].Headers)
	}

	s.registerSessionMcpServers("ws-1", "sess-1", entries)

	persisted, err := store.GetSessionMcpServers("ws-1", "sess-1")
	if err != nil {
		t.Fatalf("GetSessionMcpServers: %v", err)
	}
	if len(persisted) != 2 {
		t.Fatalf("expected 2 persisted servers, got %d", len(persisted))
	}
	gotPersisted := make([]acp.McpHeader, len(persisted[1].Headers))
	for i, header := range persisted[1].Headers {
		gotPersisted[i] = acp.McpHeader{Name: header.Name, Value: header.Value}
	}
	assertHeaders(t, "persistence", gotPersisted, wantHeaders)

	// A vm-agent restart empties the in-memory map; the SessionHost is then built from SQLite.
	hostKey := "ws-1:sess-1"
	delete(s.sessionMcpServers, hostKey)
	host := s.getOrCreateSessionHost(hostKey, "ws-1", "sess-1", agentsessions.Session{
		ID:          "sess-1",
		WorkspaceID: "ws-1",
		AgentType:   "claude-code",
		CreatedAt:   time.Now().UTC(),
		UpdatedAt:   time.Now().UTC(),
	}, nil, "")
	if host == nil {
		t.Fatal("expected SessionHost")
	}

	backfilled := s.sessionMcpServers[hostKey]
	if len(backfilled) != 2 {
		t.Fatalf("expected 2 backfilled servers, got %d", len(backfilled))
	}
	// Liveness: the fields that already round-tripped still do, so a passing header assertion
	// cannot mean the backfill returned something unrelated.
	if backfilled[1].Name != "composio" || backfilled[1].URL != "https://backend.composio.dev/v3/mcp/x" {
		t.Fatalf("backfilled entry lost its identity: %#v", backfilled[1])
	}
	assertHeaders(t, "restart backfill", backfilled[1].Headers, wantHeaders)
}

// normalizeMcpServers is the trust boundary for control-plane-supplied values. A malformed
// header fails the whole request (like a malformed URL), and the error it returns travels to
// the control plane, so it must identify the server without echoing the value.
func TestNormalizeMcpServersRejectsUnsafeHeaders(t *testing.T) {
	const secret = "ak_live_secret"
	cases := []struct {
		name   string
		header acp.McpHeader
	}{
		{"header name mcp-remote cannot parse", acp.McpHeader{Name: "x:api-key", Value: secret}},
		{"header value with a line break", acp.McpHeader{Name: "x-api-key", Value: secret + "\n[mcp_servers.x]"}},
		{"empty header value", acp.McpHeader{Name: "x-api-key", Value: ""}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := normalizeMcpServers([]acp.McpServerEntry{
				{URL: "https://api.example.com/mcp", Token: "sam-token", Name: acp.SamMcpServerName},
				{URL: "https://backend.composio.dev/mcp", Name: "composio", Headers: []acp.McpHeader{tc.header}},
			})
			if err == nil {
				t.Fatal("expected normalizeMcpServers to reject the header")
			}
			if !strings.Contains(err.Error(), "mcpServers[1]") {
				t.Errorf("error %q does not identify the offending server", err)
			}
			if strings.Contains(err.Error(), secret) {
				t.Errorf("error leaks the header value: %q", err)
			}
		})
	}
}

func assertHeaders(t *testing.T, stage string, got, want []acp.McpHeader) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: headers = %#v, want %#v", stage, got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("%s: header[%d] = %#v, want %#v", stage, i, got[i], want[i])
		}
	}
}
