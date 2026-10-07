package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
)

func TestHTTPCreateFreshMcpThenRestoreAdmitsPersistedTabAndPreservesCredentials(t *testing.T) {
	s, input := newRestoreRetryTestServer(t)
	s.agentSessions = agentsessions.NewManager()
	validator, key := newWorkspaceCreateJWTValidator(t, "node-test")
	s.jwtValidator = validator
	token := signWorkspaceCreateNodeToken(t, key, "node-test", "ws")
	request := httptest.NewRequest(http.MethodPost, "/workspaces/ws/agent-sessions", strings.NewReader(
		`{"sessionId":"session","label":"Restored session","chatSessionId":"chat","projectId":"project","mcpServers":[{"name":"sam-mcp","url":"https://api.example.test/mcp","token":"fresh-wake-token"}]}`))
	request.SetPathValue("workspaceId", "ws")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-SAM-Workspace-Id", "ws")
	response := httptest.NewRecorder()
	s.handleCreateAgentSession(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("create before restore status = %d", response.Code)
	}
	if len(s.sessionHosts) != 0 {
		t.Fatal("MCP preparation started a host before snapshot restore")
	}
	tabs, err := s.store.ListTabs("ws")
	if err != nil || len(tabs) != 1 || tabs[0].ID != "session" {
		t.Fatalf("create did not establish expected durable tab: %v", err)
	}
	fresh := []acp.McpServerEntry{{Name: "sam-mcp", URL: "https://api.example.test/mcp", Token: "fresh-wake-token"}}
	// Model a stale credentials row from older persisted state. The live
	// control-plane injection must win when the restore creates the host.
	if err := s.store.UpsertSessionMcpServers("ws", "session", toPersistedMcpServers([]acp.McpServerEntry{
		{Name: "sam-mcp", URL: "https://api.example.test/mcp", Token: "expired-snapshot-token"},
	})); err != nil {
		t.Fatal(err)
	}
	input.runtimeContract = restoredTestContract()
	input.agentType = "codex"
	result, err := s.runSessionRestore(context.Background(), input, func(context.Context) map[string]interface{} {
		session, exists := s.agentSessions.Get("ws", "session")
		if !exists {
			t.Error("created session disappeared before restore")
			return nil
		}
		host := s.getOrCreateSessionHostForRestore("ws:session", "ws", "session", session, input.runtime, "", true)
		if host == nil {
			t.Error("restore could not create host after HTTP session preparation")
		}
		if !reflect.DeepEqual(s.sessionMcpServers["ws:session"], fresh) {
			t.Error("host factory replaced fresh MCP credentials with stale persisted credentials")
		}
		return map[string]interface{}{"status": "restored"}
	})
	if err != nil || result["status"] != "restored" {
		t.Fatalf("create then restore failed admission: %v", err)
	}
	s.stopSessionHost("ws", "session")
}
