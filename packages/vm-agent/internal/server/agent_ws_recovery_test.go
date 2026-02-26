package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
)

func newAgentWSTestServer(t *testing.T) (*Server, *httptest.Server, string) {
	t.Helper()

	cfg := &config.Config{
		AllowedOrigins:    []string{"*"},
		WSReadBufferSize:  4096,
		WSWriteBufferSize: 4096,
		ContainerMode:     false,
	}

	sessionManager := auth.NewSessionManager("session", false, 1*time.Hour)
	session, err := sessionManager.CreateSession(&auth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{Subject: "test-user"},
		Workspace:        "WS_TEST",
	})
	if err != nil {
		t.Fatalf("create auth session: %v", err)
	}

	s := &Server{
		config:          cfg,
		sessionManager:  sessionManager,
		workspaces:      make(map[string]*WorkspaceRuntime),
		workspaceEvents: make(map[string][]EventRecord),
		agentSessions:   agentsessions.NewManager(),
		acpConfig:       acp.GatewayConfig{},
		sessionHosts:    make(map[string]*acp.SessionHost),
	}

	ts := httptest.NewServer(http.HandlerFunc(s.handleAgentWS))
	t.Cleanup(ts.Close)

	return s, ts, session.ID
}

func dialAgentWS(t *testing.T, ts *httptest.Server, cookieSessionID, workspaceID, sessionID string) *websocket.Conn {
	t.Helper()

	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "?sessionId=" + sessionID
	header := http.Header{}
	header.Set("Cookie", "session="+cookieSessionID)
	header.Set("X-SAM-Workspace-Id", workspaceID)

	conn, _, err := websocket.DefaultDialer.Dial(url, header)
	if err != nil {
		t.Fatalf("dial ws: %v", err)
	}
	return conn
}

func TestHandleAgentWS_AutoResumesSuspendedSession(t *testing.T) {
	s, ts, cookieSessionID := newAgentWSTestServer(t)

	const (
		workspaceID = "WS_TEST"
		sessionID   = "sess-suspended"
	)

	// Pre-create the session and suspend it
	_, _, err := s.agentSessions.Create(workspaceID, sessionID, "Suspended Chat", "")
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	_, err = s.agentSessions.Suspend(workspaceID, sessionID)
	if err != nil {
		t.Fatalf("suspend session: %v", err)
	}

	// Verify it's suspended before the WebSocket connect
	preSession, exists := s.agentSessions.Get(workspaceID, sessionID)
	if !exists {
		t.Fatal("expected session to exist before WebSocket connect")
	}
	if preSession.Status != agentsessions.StatusSuspended {
		t.Fatalf("expected suspended status before connect, got %s", preSession.Status)
	}

	// Connect via WebSocket — this should auto-resume the session
	conn := dialAgentWS(t, ts, cookieSessionID, workspaceID, sessionID)
	_ = conn.Close()

	// Verify the session was auto-resumed to running
	postSession, exists := s.agentSessions.Get(workspaceID, sessionID)
	if !exists {
		t.Fatal("expected session to exist after WebSocket connect")
	}
	if postSession.Status != agentsessions.StatusRunning {
		t.Fatalf("expected running status after auto-resume, got %s", postSession.Status)
	}
}

func TestHandleAgentWS_RejectsStoppedSession(t *testing.T) {
	s, ts, cookieSessionID := newAgentWSTestServer(t)

	const (
		workspaceID = "WS_TEST"
		sessionID   = "sess-stopped"
	)

	// Pre-create the session and stop it
	_, _, err := s.agentSessions.Create(workspaceID, sessionID, "Stopped Chat", "")
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	_, err = s.agentSessions.Stop(workspaceID, sessionID)
	if err != nil {
		t.Fatalf("stop session: %v", err)
	}

	// Attempt WebSocket connect — should fail because stopped sessions can't be auto-resumed
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "?sessionId=" + sessionID
	header := http.Header{}
	header.Set("Cookie", "session="+cookieSessionID)
	header.Set("X-SAM-Workspace-Id", workspaceID)

	_, resp, err := websocket.DefaultDialer.Dial(url, header)
	if err == nil {
		t.Fatal("expected WebSocket dial to fail for stopped session")
	}
	if resp != nil && resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected HTTP 409 Conflict, got %d", resp.StatusCode)
	}
}

func TestHandleAgentWS_ConcurrentResumeAlreadyRunning(t *testing.T) {
	s, ts, cookieSessionID := newAgentWSTestServer(t)

	const (
		workspaceID = "WS_TEST"
		sessionID   = "sess-concurrent"
	)

	// Pre-create the session and suspend it
	_, _, err := s.agentSessions.Create(workspaceID, sessionID, "Concurrent Chat", "")
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	_, err = s.agentSessions.Suspend(workspaceID, sessionID)
	if err != nil {
		t.Fatalf("suspend session: %v", err)
	}

	// Simulate the race: resume the session before WebSocket connects (as if a
	// concurrent connection already resumed it). The Resume() call inside
	// handleAgentWS will fail because the session is no longer suspended, but
	// the handler should detect it's already running and proceed.
	_, err = s.agentSessions.Resume(workspaceID, sessionID)
	if err != nil {
		t.Fatalf("pre-resume session: %v", err)
	}
	// Re-suspend so the WebSocket handler sees StatusSuspended in its initial Get(),
	// then immediately resume again to simulate a concurrent resume winning the race.
	_, err = s.agentSessions.Suspend(workspaceID, sessionID)
	if err != nil {
		t.Fatalf("re-suspend session: %v", err)
	}

	// Now resume from a "concurrent" connection right before our WebSocket connects.
	// We can't perfectly simulate the race, but we can test the fallback path by
	// making Resume() fail. To do this, resume the session so the handler's
	// Resume() call will fail with "cannot be resumed from status running".
	_, err = s.agentSessions.Resume(workspaceID, sessionID)
	if err != nil {
		t.Fatalf("concurrent resume: %v", err)
	}

	// The session is now running. A WebSocket connect should succeed (the handler
	// will see running status and skip the auto-resume path entirely).
	conn := dialAgentWS(t, ts, cookieSessionID, workspaceID, sessionID)
	_ = conn.Close()

	// Verify session is still running
	postSession, exists := s.agentSessions.Get(workspaceID, sessionID)
	if !exists {
		t.Fatal("expected session to exist after WebSocket connect")
	}
	if postSession.Status != agentsessions.StatusRunning {
		t.Fatalf("expected running status, got %s", postSession.Status)
	}
}

func TestHandleAgentWS_RecreatesMissingRequestedSession(t *testing.T) {
	s, ts, cookieSessionID := newAgentWSTestServer(t)

	const (
		workspaceID = "WS_TEST"
		sessionID   = "sess-recover"
	)

	conn := dialAgentWS(t, ts, cookieSessionID, workspaceID, sessionID)
	_ = conn.Close()

	recovered, exists := s.agentSessions.Get(workspaceID, sessionID)
	if !exists {
		t.Fatalf("expected recovered session %s to exist", sessionID)
	}
	if recovered.Status != agentsessions.StatusRunning {
		t.Fatalf("session status = %s, want %s", recovered.Status, agentsessions.StatusRunning)
	}

	s.eventMu.RLock()
	events := append([]EventRecord(nil), s.workspaceEvents[workspaceID]...)
	s.eventMu.RUnlock()

	if len(events) == 0 {
		t.Fatal("expected workspace events to include session recovery event")
	}

	foundRecovered := false
	for _, event := range events {
		if event.Type == "agent.session_recovered" {
			foundRecovered = true
			break
		}
	}
	if !foundRecovered {
		t.Fatalf("expected agent.session_recovered event, got %d events", len(events))
	}
}
