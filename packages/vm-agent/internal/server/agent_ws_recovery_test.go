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
