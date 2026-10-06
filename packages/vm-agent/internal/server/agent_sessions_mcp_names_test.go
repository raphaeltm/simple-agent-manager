package server

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/messagereport"
	"github.com/workspace/vm-agent/internal/persistence"
)

func newMcpTestServer(t *testing.T) (*Server, *persistence.Store) {
	t.Helper()
	store, err := persistence.Open(filepath.Join(t.TempDir(), "vm-agent.db"))
	if err != nil {
		t.Fatalf("Open persistence store: %v", err)
	}
	t.Cleanup(func() { store.Close() })

	return &Server{
		config: &config.Config{
			NodeID:               "node-test",
			ACPMessageBufferSize: 64,
			ACPViewerSendBuffer:  8,
			CallbackToken:        "node-callback-token",
		},
		workspaces:          map[string]*WorkspaceRuntime{},
		workspaceEvents:     map[string][]EventRecord{},
		agentSessions:       agentsessions.NewManager(),
		sessionHosts:        map[string]*acp.SessionHost{},
		sessionMcpServers:   map[string][]acp.McpServerEntry{},
		sessionProfileOvr:   map[string]profileOverrides{},
		sessionTaskCtx:      map[string]taskCallbackContext{},
		store:               store,
		messageReporters:    map[string]*messagereport.Reporter{},
		bootLogBroadcasters: NewBootLogBroadcasterManager(),
	}, store
}

// TestMcpServerNameSurvivesFullRoundTrip is the guard for the three field-by-field struct
// conversions that MCP entries pass through: normalizeMcpServers rebuilds the struct,
// registerSessionMcpServers converts acp -> persistence, and the agent_ws prefetch converts
// persistence -> acp. Each one silently drops a field it does not copy — there is no compile
// error — so a field added upstream and forgotten in any of the three would vanish with every
// existing test still green.
func TestMcpServerNameSurvivesFullRoundTrip(t *testing.T) {
	s, store := newMcpTestServer(t)

	entries, err := normalizeMcpServers([]acp.McpServerEntry{
		{URL: " https://api.example.com/mcp ", Token: "sam-token", Name: acp.SamMcpServerName},
		{URL: "https://mcp.zapier.com/x", Token: "zap-token", Name: "zapier"},
		{URL: "https://presigned.example/mcp?k=1", Token: "", Name: "composio"},
	})
	if err != nil {
		t.Fatalf("normalizeMcpServers: %v", err)
	}

	// Conversion 1: normalizeMcpServers must carry Name through its struct rebuild.
	if len(entries) != 3 {
		t.Fatalf("expected 3 normalized entries, got %d", len(entries))
	}
	wantNames := []string{acp.SamMcpServerName, "zapier", "composio"}
	for i, want := range wantNames {
		if entries[i].Name != want {
			t.Errorf("normalizeMcpServers dropped name at %d: got %q, want %q", i, entries[i].Name, want)
		}
	}

	s.registerSessionMcpServers("ws-1", "sess-1", entries)

	// Conversion 2: acp -> persistence, then read back out of SQLite.
	persisted, err := store.GetSessionMcpServers("ws-1", "sess-1")
	if err != nil {
		t.Fatalf("GetSessionMcpServers: %v", err)
	}
	if len(persisted) != 3 {
		t.Fatalf("expected 3 persisted entries, got %d", len(persisted))
	}
	for i, want := range wantNames {
		if persisted[i].Name != want {
			t.Errorf("persistence dropped name at %d: got %q, want %q", i, persisted[i].Name, want)
		}
	}
	if persisted[2].Token != "" {
		t.Errorf("tokenless entry should persist an empty token, got %q", persisted[2].Token)
	}

	// Conversion 3: persistence -> acp on the restart/backfill path. Clearing the in-memory
	// map is what a vm-agent restart looks like to getOrCreateSessionHost.
	hostKey := "ws-1:sess-1"
	delete(s.sessionMcpServers, hostKey)

	host := s.getOrCreateSessionHost(hostKey, "ws-1", "sess-1", agentsessions.Session{
		ID:          "sess-1",
		WorkspaceID: "ws-1",
		AgentType:   "amp",
		CreatedAt:   time.Now().UTC(),
		UpdatedAt:   time.Now().UTC(),
	}, nil, "")
	if host == nil {
		t.Fatal("expected SessionHost")
	}

	backfilled := s.sessionMcpServers[hostKey]
	if len(backfilled) != 3 {
		t.Fatalf("expected 3 backfilled entries, got %d", len(backfilled))
	}
	for i, want := range wantNames {
		if backfilled[i].Name != want {
			t.Errorf("backfill dropped name at %d: got %q, want %q", i, backfilled[i].Name, want)
		}
	}
}

// A vm-agent that has been upgraded still holds rows written before the name column existed.
// Those must keep working via the positional fallback rather than resolving to empty names.
func TestMcpServersWithoutNamesStillResolve(t *testing.T) {
	s, store := newMcpTestServer(t)

	entries, err := normalizeMcpServers([]acp.McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "sam-token"},
	})
	if err != nil {
		t.Fatalf("normalizeMcpServers: %v", err)
	}
	if entries[0].Name != "" {
		t.Fatalf("expected empty name for an unnamed entry, got %q", entries[0].Name)
	}

	s.registerSessionMcpServers("ws-2", "sess-2", entries)
	persisted, err := store.GetSessionMcpServers("ws-2", "sess-2")
	if err != nil {
		t.Fatalf("GetSessionMcpServers: %v", err)
	}
	if len(persisted) != 1 || persisted[0].Name != "" {
		t.Fatalf("unexpected persisted rows: %#v", persisted)
	}

	names := acp.ResolveMcpServerNames(entries)
	if names[0] != acp.SamMcpServerName {
		t.Errorf("unnamed single entry resolved to %q, want %q", names[0], acp.SamMcpServerName)
	}
}

// normalizeMcpServers is the trust boundary for control-plane-supplied values. The URL rules
// predate this change; this pins that they still apply to every entry in a multi-server list,
// not just the first.
func TestNormalizeMcpServersValidatesEveryEntry(t *testing.T) {
	cases := []struct {
		name    string
		entries []acp.McpServerEntry
	}{
		{
			name: "plain http on a non-loopback host",
			entries: []acp.McpServerEntry{
				{URL: "https://api.example.com/mcp", Token: "t", Name: acp.SamMcpServerName},
				{URL: "http://evil.example.com/mcp", Token: "t", Name: "evil"},
			},
		},
		{
			name: "blank url in a later entry",
			entries: []acp.McpServerEntry{
				{URL: "https://api.example.com/mcp", Token: "t", Name: acp.SamMcpServerName},
				{URL: "   ", Token: "t", Name: "blank"},
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := normalizeMcpServers(tc.entries); err == nil {
				t.Error("expected normalizeMcpServers to reject the entry list")
			}
		})
	}
}
