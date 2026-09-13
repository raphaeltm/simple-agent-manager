package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/workspace/vm-agent/internal/agentsessions"
)

type creationResponseWriter struct {
	*httptest.ResponseRecorder
	beforeSuccess func()
}

func (w *creationResponseWriter) WriteHeader(status int) {
	if status == http.StatusCreated {
		w.beforeSuccess()
	}
	w.ResponseRecorder.WriteHeader(status)
}

func TestSessionCreationReservationBlocksRestoreHostsAndCanceledRetries(t *testing.T) {
	s, input := newRestoreRetryTestServer(t)
	finish, err := s.beginSessionCreation(context.Background(), "ws", "session")
	if err != nil {
		t.Fatal(err)
	}
	session, _ := s.agentSessions.Get("ws", "session")
	if host := s.getOrCreateSessionHost("ws:session", "ws", "session", session, input.runtime, ""); host != nil {
		t.Error("host captured reporter before create setup finished")
	}
	if _, err := s.runSessionRestore(context.Background(), input, func() map[string]interface{} {
		t.Error("restore ran before create setup finished")
		return nil
	}); err == nil {
		t.Error("restore accepted an incomplete creation")
	}
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		close(ready)
		release, err := s.beginSessionCreation(ctx, "ws", "session")
		if release != nil {
			release()
		}
		result <- err
	}()
	<-ready
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Errorf("create retry passed incomplete setup or lost cancellation: %v", err)
	}
	finish()
	release, err := s.beginSessionCreation(context.Background(), "ws", "session")
	if err != nil {
		t.Fatal(err)
	}
	release()
	if len(s.sessionCreations) != 0 {
		t.Fatal("creation reservations leaked")
	}
}

func TestSessionRestoreRejectsConcurrentStartAndSiblingCreateBeforeMetadataEffects(t *testing.T) {
	s, input := newRestoreRetryTestServer(t)
	validator, key := newWorkspaceCreateJWTValidator(t, "node-test")
	s.jwtValidator = validator
	token := signWorkspaceCreateNodeToken(t, key, "node-test", "ws")
	post := func(handler http.HandlerFunc, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/workspaces/ws/agent-sessions/session/start", strings.NewReader(body))
		req.SetPathValue("workspaceId", "ws")
		req.SetPathValue("sessionId", "session")
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-SAM-Workspace-Id", "ws")
		rec := httptest.NewRecorder()
		handler(rec, req)
		return rec
	}
	_, err := s.runSessionRestore(context.Background(), input, func() map[string]interface{} {
		start := post(s.handleStartAgentSession, `{"agentType":"claude-code","initialPrompt":"must not run","model":"other","taskId":"other-task","projectId":"other-project","mcpServers":[{"url":"https://other.example/mcp","token":"other"}]}`)
		if start.Code != http.StatusConflict {
			t.Errorf("concurrent start status = %d %s", start.Code, start.Body.String())
		}
		if len(s.sessionProfileOvr) != 0 || len(s.sessionTaskCtx) != 0 || len(s.sessionMcpServers) != 0 {
			t.Error("refused start changed restore profile, task ownership, or MCP settings")
		}
		create := post(s.handleCreateAgentSession, `{"sessionId":"sibling","label":"Sibling","chatSessionId":"other-chat","projectId":"other-project"}`)
		if create.Code != http.StatusConflict || len(s.agentSessions.List("ws")) != 1 || s.workspaces["ws"].ProjectID != "project" {
			t.Errorf("concurrent sibling create changed routing: %d %s", create.Code, create.Body.String())
		}
		retry := post(s.handleCreateAgentSession, `{"sessionId":"session","label":"Original","chatSessionId":"chat","projectId":"project","mcpServers":[{"url":"https://other.example/mcp"}]}`)
		if retry.Code != http.StatusCreated || len(s.sessionMcpServers) != 0 {
			t.Errorf("same-identity create retry changed restore settings: %d %s", retry.Code, retry.Body.String())
		}
		return map[string]interface{}{"status": "restored"}
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestCreateAgentSessionRetryAndRestartFence(t *testing.T) {
	s, _ := newRestoreRetryTestServer(t)
	s.agentSessions = agentsessions.NewManager()
	validator, key := newWorkspaceCreateJWTValidator(t, "node-test")
	s.jwtValidator = validator
	token := signWorkspaceCreateNodeToken(t, key, "node-test", "ws")
	post := func(body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/workspaces/ws/agent-sessions", strings.NewReader(body))
		req.SetPathValue("workspaceId", "ws")
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-SAM-Workspace-Id", "ws")
		rec := httptest.NewRecorder()
		s.handleCreateAgentSession(&creationResponseWriter{ResponseRecorder: rec, beforeSuccess: func() {
			s.sessionHostMu.Lock()
			pending := s.workspaceCreationPendingLocked("ws")
			s.sessionHostMu.Unlock()
			if pending {
				t.Error("create published success before runtime setup reservation was released")
			}
		}}, req)
		return rec
	}
	// Blank chat routing keeps this test focused on create persistence without
	// starting the unrelated background reporter. Project identity is still bound.
	body := `{"sessionId":"session","label":"Original","projectId":"project"}`
	for range 2 {
		rec := post(body)
		if rec.Code != http.StatusCreated {
			t.Fatalf("same-process retry = %d %s", rec.Code, rec.Body.String())
		}
	}
	tabs, err := s.store.ListTabs("ws")
	if err != nil || len(tabs) != 1 {
		t.Fatalf("retry changed durable tab count: %v, %v", tabs, err)
	}
	rec := post(`{"sessionId":"session","label":"Original","projectId":"other"}`)
	if rec.Code != http.StatusBadRequest || s.workspaces["ws"].ProjectID != "project" {
		t.Fatalf("conflicting create changed routing: %d %s", rec.Code, rec.Body.String())
	}
	s.agentSessions = agentsessions.NewManager()
	rec = post(body)
	if rec.Code != http.StatusConflict || len(s.agentSessions.List("ws")) != 0 {
		t.Fatalf("restart adopted persisted tab: %d %s", rec.Code, rec.Body.String())
	}
	// Interactive reconstruction does not confer create provenance either.
	if _, _, err := s.agentSessions.Create("ws", "session", "Original", ""); err != nil {
		t.Fatal(err)
	}
	rec = post(body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("reloaded session accepted bootstrap: %d %s", rec.Code, rec.Body.String())
	}
}
