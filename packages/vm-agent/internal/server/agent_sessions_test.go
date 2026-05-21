package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/messagereport"
	"github.com/workspace/vm-agent/internal/persistence"
)

func TestAgentSessionsSourceContract(t *testing.T) {
	path := filepath.Join("workspaces.go")
	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	content := string(contentBytes)

	for _, needle := range []string{
		"handleListAgentSessions",
		"handleCreateAgentSession",
		"handleStartAgentSession",
		"handleCancelAgentSession",
		"handleStopAgentSession",
		"Idempotency-Key",
		// Session visibility enrichment
		"enrichedSession",
		"HostStatus",
		"ViewerCount",
		"host.Status()",
		"host.ViewerCount()",
		// Per-workspace message reporter creation
		"getOrCreateReporter",
		`"projectId"`,
		`"mcpServers,omitempty"`,
		"normalizeMcpServers",
		"registerSessionMcpServers",
	} {
		if !strings.Contains(content, needle) {
			t.Fatalf("expected %q in %s", needle, path)
		}
	}
}

func TestStartAgentSessionSourceContract(t *testing.T) {
	path := filepath.Join("workspaces.go")
	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	content := string(contentBytes)

	// Verify the start endpoint handler exists and has the required structure
	for _, needle := range []string{
		"handleStartAgentSession",
		"startAgentWithPrompt",
		`"agentType"`,
		`"initialPrompt"`,
		"agentType is required",
		"initialPrompt is required",
		"getOrCreateSessionHost",
		"SelectAgent",
		"HandlePrompt",
		"OnPromptCompleteCallback",
		"agent_session.starting",
		"agent_session.start_failed",
		"agent_session.prompt_sent",
		// Duplicate prompt protection: HostPrompting must cause early return
		"HostPrompting",
		"skipping duplicate",
	} {
		if !strings.Contains(content, needle) {
			t.Fatalf("expected %q in %s for start endpoint", needle, path)
		}
	}
}

func TestStartAgentSessionRouteRegistration(t *testing.T) {
	path := filepath.Join("server.go")
	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	content := string(contentBytes)

	route := `"POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/start"`
	if !strings.Contains(content, route) {
		t.Fatalf("missing route registration: %s", route)
	}
}

func TestCreateAgentSessionMcpServersPersistAndBackfillBeforeSessionHost(t *testing.T) {
	store, err := persistence.Open(filepath.Join(t.TempDir(), "vm-agent.db"))
	if err != nil {
		t.Fatalf("Open persistence store: %v", err)
	}
	defer store.Close()

	s := &Server{
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
	}

	entries, err := normalizeMcpServers([]acp.McpServerEntry{
		{URL: " https://api.example.com/mcp ", Token: "mcp-token"},
	})
	if err != nil {
		t.Fatalf("normalizeMcpServers: %v", err)
	}

	s.registerSessionMcpServers("ws-1", "sess-1", entries)

	hostKey := "ws-1:sess-1"
	inMemory := s.sessionMcpServers[hostKey]
	if len(inMemory) != 1 || inMemory[0].URL != "https://api.example.com/mcp" || inMemory[0].Token != "mcp-token" {
		t.Fatalf("unexpected in-memory MCP servers: %#v", inMemory)
	}

	persisted, err := store.GetSessionMcpServers("ws-1", "sess-1")
	if err != nil {
		t.Fatalf("GetSessionMcpServers: %v", err)
	}
	if len(persisted) != 1 || persisted[0].URL != "https://api.example.com/mcp" || persisted[0].Token != "mcp-token" {
		t.Fatalf("unexpected persisted MCP servers: %#v", persisted)
	}

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
	if len(backfilled) != 1 || backfilled[0].URL != "https://api.example.com/mcp" || backfilled[0].Token != "mcp-token" {
		t.Fatalf("expected persisted MCP servers to backfill before SessionHost creation, got %#v", backfilled)
	}
}
