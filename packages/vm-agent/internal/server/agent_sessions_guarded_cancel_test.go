package server

import (
	"github.com/workspace/vm-agent/internal/acp"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGuardedCancelEndpointAuthorizationAndValidation(t *testing.T) {
	s, _ := newRestoreRetryTestServer(t)
	validator, key := newWorkspaceCreateJWTValidator(t, "node-test")
	s.jwtValidator = validator
	token := signWorkspaceCreateNodeToken(t, key, "node-test", "ws")
	s.sessionHosts["ws:session"] = acp.NewSessionHost(acp.SessionHostConfig{})
	for _, tc := range []struct {
		name, body, token, workspace string
		code                         int
	}{
		{"unauthenticated", `{"expectedPromptStartedAt":1}`, "", "ws", http.StatusUnauthorized},
		{"wrong workspace", `{"expectedPromptStartedAt":1}`, token, "other", http.StatusUnauthorized},
		{"missing guard", `{}`, token, "ws", http.StatusBadRequest},
		{"unknown field", `{"expectedPromptStartedAt":1,"force":true}`, token, "ws", http.StatusBadRequest},
		{"trailing object", `{"expectedPromptStartedAt":1}{}`, token, "ws", http.StatusBadRequest},
		{"idle", `{"expectedPromptStartedAt":1}`, token, "ws", http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/workspaces/"+tc.workspace+"/agent-sessions/session/cancel-guarded", strings.NewReader(tc.body))
			req.SetPathValue("workspaceId", tc.workspace)
			req.SetPathValue("sessionId", "session")
			req.Header.Set("X-SAM-Workspace-Id", tc.workspace)
			if tc.token != "" {
				req.Header.Set("Authorization", "Bearer "+tc.token)
			}
			response := httptest.NewRecorder()
			s.handleGuardedCancelAgentSession(response, req)
			if response.Code != tc.code {
				t.Fatalf("status %d, want %d: %s", response.Code, tc.code, response.Body.String())
			}
			if tc.name == "idle" && !strings.Contains(response.Body.String(), `"idle"`) {
				t.Fatal("missing idle outcome")
			}
		})
	}
}
