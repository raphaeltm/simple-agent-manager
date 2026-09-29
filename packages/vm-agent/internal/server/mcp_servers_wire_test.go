package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/workspace/vm-agent/internal/acp"
)

// Go half of the MCP server wire contract. apps/api/tests/unit/node-agent-contract.test.ts
// asserts the control plane serializes exactly this fixture; here it is posted to the real
// create-agent-session handler, so a renamed JSON tag on either side fails one of the two.
func TestCreateAgentSessionAcceptsWireFixtureHeaders(t *testing.T) {
	fixture, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "..", "packages", "shared", "src", "fixtures", "mcp-server-entry-wire.json",
	))
	if err != nil {
		t.Fatalf("read shared wire fixture: %v", err)
	}
	var wire struct {
		McpServers json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(fixture, &wire); err != nil || len(wire.McpServers) == 0 {
		t.Fatalf("parse shared wire fixture: %v", err)
	}

	s, store := newMcpTestServer(t)
	s.workspaces["ws"] = &WorkspaceRuntime{ID: "ws", ProjectID: "project", Status: "running", CallbackToken: "cb"}
	validator, key := newWorkspaceCreateJWTValidator(t, "node-test")
	s.jwtValidator = validator

	body := `{"sessionId":"sess-wire","label":"Wire","chatSessionId":"chat","projectId":"project","mcpServers":` +
		string(wire.McpServers) + `}`
	req := httptest.NewRequest(http.MethodPost, "/workspaces/ws/agent-sessions", strings.NewReader(body))
	req.SetPathValue("workspaceId", "ws")
	req.Header.Set("Authorization", "Bearer "+signWorkspaceCreateNodeToken(t, key, "node-test", "ws"))
	req.Header.Set("X-SAM-Workspace-Id", "ws")
	rec := httptest.NewRecorder()
	s.handleCreateAgentSession(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create agent session status = %d: %s", rec.Code, rec.Body.String())
	}

	wantComposioHeaders := []acp.McpHeader{
		{Name: "x-api-key", Value: "ak_fixture_key"},
		{Name: "X-Org_Id", Value: "org-42"},
	}
	registered := s.sessionMcpServers["ws:sess-wire"]
	if len(registered) != 3 {
		t.Fatalf("registered %d MCP servers, want 3: %#v", len(registered), registered)
	}
	if registered[1].Name != "composio" || registered[1].Token != "" {
		t.Fatalf("composio entry arrived as %#v", registered[1])
	}
	assertHeaders(t, "handler", registered[1].Headers, wantComposioHeaders)
	for _, i := range []int{0, 2} {
		if len(registered[i].Headers) != 0 {
			t.Errorf("%s gained headers it was never sent: %#v", registered[i].Name, registered[i].Headers)
		}
	}

	persisted, err := store.GetSessionMcpServers("ws", "sess-wire")
	if err != nil || len(persisted) != 3 {
		t.Fatalf("persisted servers = %#v, err %v", persisted, err)
	}
	if len(persisted[1].Headers) != len(wantComposioHeaders) || persisted[1].Headers[0].Value != "ak_fixture_key" {
		t.Errorf("persisted composio headers = %#v", persisted[1].Headers)
	}
}
