package server

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/persistence"
)

func tempServerStore(t *testing.T) *persistence.Store {
	t.Helper()
	store, err := persistence.Open(filepath.Join(t.TempDir(), "events.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

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

func TestRegisterSessionMcpServersPersistsBeforeWebSocketHost(t *testing.T) {
	s := newContractTestServer()
	s.sessionMcpServers = make(map[string][]acp.McpServerEntry)
	s.store = tempServerStore(t)

	rec := httptest.NewRecorder()
	ok := s.registerSessionMcpServers(rec, "ws-existing", "sess-mcp", []acp.McpServerEntry{
		{URL: " https://api.example.com/mcp ", Token: "secret-token"},
	})
	if !ok {
		t.Fatalf("expected MCP registration to succeed, response: %s", rec.Body.String())
	}

	hostKey := "ws-existing:sess-mcp"
	registered := s.sessionMcpServers[hostKey]
	if len(registered) != 1 {
		t.Fatalf("expected 1 in-memory MCP server, got %d", len(registered))
	}
	if registered[0].URL != "https://api.example.com/mcp" {
		t.Fatalf("expected trimmed URL, got %q", registered[0].URL)
	}
	if registered[0].Token != "secret-token" {
		t.Fatal("expected token to be preserved for ACP Authorization header injection")
	}

	persisted, err := s.store.GetSessionMcpServers("ws-existing", "sess-mcp")
	if err != nil {
		t.Fatalf("GetSessionMcpServers: %v", err)
	}
	if len(persisted) != 1 {
		t.Fatalf("expected 1 persisted MCP server, got %d", len(persisted))
	}
	if persisted[0].URL != "https://api.example.com/mcp" {
		t.Fatalf("expected persisted URL, got %q", persisted[0].URL)
	}
	if persisted[0].Token != "secret-token" {
		t.Fatal("expected persisted token to be available before ACP host creation")
	}
}
