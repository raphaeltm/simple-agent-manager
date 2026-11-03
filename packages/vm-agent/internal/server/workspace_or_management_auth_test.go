package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/workspace/vm-agent/internal/agentsessions"
)

// The control plane reads a workspace's live agent sessions and tabs with a node-management
// token (session-activity probe, task host probe, Operations tools). These routes also accept
// the workspace's own cookie. Before requireWorkspaceOrManagementAuth, the workspace check wrote
// a 401 "invalid token" first, so the management token could never succeed.
func TestWorkspaceReadRoutesAcceptManagementToken(t *testing.T) {
	fx := newDiagnosticAuthFixture(t)
	defer fx.stop()
	fx.server.agentSessions = agentsessions.NewManager()
	if _, _, err := fx.server.agentSessions.Create(workspaceAID, "acp-1", "chat", ""); err != nil {
		t.Fatalf("Create: %v", err)
	}

	routes := []struct {
		name    string
		path    string
		handler http.HandlerFunc
		wantKey string
	}{
		{name: "agent sessions", path: "/workspaces/" + workspaceAID + "/agent-sessions", handler: fx.server.handleListAgentSessions, wantKey: "sessions"},
		{name: "tabs", path: "/workspaces/" + workspaceAID + "/tabs", handler: fx.server.handleListTabs, wantKey: "tabs"},
	}
	credentials := []struct {
		name     string
		apply    func(*http.Request)
		wantCode int
	}{
		// The API sends the workspace header with every workspace-scoped call (nodeAgentRequest).
		{name: "management token", apply: func(r *http.Request) {
			r.Header.Set("Authorization", "Bearer "+fx.workspaceMgmtA)
			r.Header.Set("X-SAM-Workspace-Id", workspaceAID)
		}, wantCode: http.StatusOK},
		{name: "workspace cookie", apply: func(r *http.Request) { r.AddCookie(fx.workspaceCookieA) }, wantCode: http.StatusOK},
		{name: "no credentials", apply: func(*http.Request) {}, wantCode: http.StatusUnauthorized},
		{name: "management token for another workspace", apply: func(r *http.Request) {
			r.Header.Set("Authorization", "Bearer "+signServerTestToken(t, fx.signingKey, diagnosticAuthNodeID, workspaceBID))
			r.Header.Set("X-SAM-Workspace-Id", workspaceAID)
		}, wantCode: http.StatusUnauthorized},
	}

	for _, route := range routes {
		for _, cred := range credentials {
			t.Run(route.name+"/"+cred.name, func(t *testing.T) {
				req := httptest.NewRequest(http.MethodGet, route.path, nil)
				req.SetPathValue("workspaceId", workspaceAID)
				cred.apply(req)
				rec := httptest.NewRecorder()

				route.handler.ServeHTTP(rec, req)

				if rec.Code != cred.wantCode {
					t.Fatalf("status = %d, want %d; body=%s", rec.Code, cred.wantCode, rec.Body.String())
				}
				// Exactly one JSON document: no 401 body glued in front of a success body.
				var body map[string]json.RawMessage
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					t.Fatalf("body is not a single JSON document: %v; body=%s", err, rec.Body.String())
				}
				if cred.wantCode == http.StatusOK {
					if _, ok := body[route.wantKey]; !ok {
						t.Fatalf("missing %q in body=%s", route.wantKey, rec.Body.String())
					}
					if route.wantKey == "sessions" && !strings.Contains(string(body["sessions"]), "acp-1") {
						t.Fatalf("sessions missing acp-1: %s", body["sessions"])
					}
				}
			})
		}
	}
}
