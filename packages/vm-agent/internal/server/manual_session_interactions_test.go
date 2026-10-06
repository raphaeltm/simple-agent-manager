package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/workspace/vm-agent/internal/acp"
)

func TestManualSessionInteractionConfigReachesHost(t *testing.T) {
	s, _ := newMcpTestServer(t)
	s.workspaces["ws"] = &WorkspaceRuntime{ID: "ws", ProjectID: "project", Status: "running", CallbackToken: "callback"}
	validator, key := newWorkspaceCreateJWTValidator(t, "node-test")
	s.jwtValidator = validator
	config := acp.AcpInteractionRuntimeConfig{
		Enabled: true, URLsEnabled: true, ProtocolVersion: 1,
		PermissionDeadlineMs: 1000, URLDeadlineMs: 1000, MaxDeadlineMs: 2000,
		DeadlineMarginMs: 100, RequestMaxBytes: 32768, OptionsMaxCount: 16,
		OptionIDMaxChars: 128, OptionNameMaxChars: 200, ReceiptLimit: 16,
		ResponseMaxBytes: 65536, URLMaxChars: 2048, URLElicitationIDMaxChars: 128,
		SettleRetryDelaysMs: []int{10}, SettleRetrySteadyMs: 100,
	}
	body, err := json.Marshal(map[string]any{
		"sessionId": "manual-session", "projectId": "project", "chatSessionId": "chat",
		"acpInteractions": config,
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/workspaces/ws/agent-sessions", strings.NewReader(string(body)))
	req.SetPathValue("workspaceId", "ws")
	req.Header.Set("Authorization", "Bearer "+signWorkspaceCreateNodeToken(t, key, "node-test", "ws"))
	req.Header.Set("X-SAM-Workspace-Id", "ws")
	rec := httptest.NewRecorder()
	s.handleCreateAgentSession(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", rec.Code, rec.Body.String())
	}
	hostKey := "ws:manual-session"
	if !s.sessionManualInteractionConfig[hostKey].URLsEnabled {
		t.Fatal("manual URL config was not retained")
	}
	session, ok := s.agentSessions.Get("ws", "manual-session")
	if !ok {
		t.Fatal("manual session missing")
	}
	host := s.getOrCreateSessionHost(hostKey, "ws", "manual-session", session, s.workspaces["ws"], "")
	if host == nil || !host.AcpInteractionBridgeEnabled() {
		t.Fatal("manual interaction config did not reach SessionHost")
	}
	s.stopSessionHost("ws", "manual-session")
	if _, ok := s.sessionManualInteractionConfig[hostKey]; ok {
		t.Fatal("stopped session retained interaction config")
	}
}

func TestManualSessionRejectsInvalidInteractionConfigBeforeCreate(t *testing.T) {
	s, _ := newMcpTestServer(t)
	validator, key := newWorkspaceCreateJWTValidator(t, "node-test")
	s.jwtValidator = validator
	req := httptest.NewRequest(http.MethodPost, "/workspaces/ws/agent-sessions", strings.NewReader(`{"sessionId":"manual-session","acpInteractions":{"enabled":true,"urlsEnabled":true,"protocolVersion":1}}`))
	req.SetPathValue("workspaceId", "ws")
	req.Header.Set("Authorization", "Bearer "+signWorkspaceCreateNodeToken(t, key, "node-test", "ws"))
	req.Header.Set("X-SAM-Workspace-Id", "ws")
	rec := httptest.NewRecorder()
	s.handleCreateAgentSession(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid config status=%d", rec.Code)
	}
	if len(s.agentSessions.List("ws")) != 0 || len(s.sessionManualInteractionConfig) != 0 {
		t.Fatal("invalid config created session or retained interaction capability")
	}
}
