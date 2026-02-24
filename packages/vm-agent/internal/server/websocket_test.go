package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/pty"
)

// newTestServer creates a minimal Server wired for multi-terminal WebSocket testing.
// It pre-creates an auth session with a known cookie so the WS handler accepts the connection.
func newTestServer(t *testing.T) (*Server, *httptest.Server, string) {
	t.Helper()

	cfg := &config.Config{
		AllowedOrigins:    []string{"*"},
		WSReadBufferSize:  4096,
		WSWriteBufferSize: 4096,
	}

	sm := auth.NewSessionManager("session", false, 1*time.Hour)
	sess, err := sm.CreateSession(&auth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{Subject: "test-user"},
	})
	if err != nil {
		t.Fatalf("create auth session: %v", err)
	}

	ptm := pty.NewManager(pty.ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		GracePeriod:  5 * time.Second,
		BufferSize:   4096,
	})

	s := &Server{
		config:         cfg,
		sessionManager: sm,
		ptyManager:     ptm,
		done:           make(chan struct{}),
	}

	ts := httptest.NewServer(http.HandlerFunc(s.handleMultiTerminalWS))
	t.Cleanup(func() {
		ts.Close()
		ptm.CloseAllSessions()
	})

	return s, ts, sess.ID
}

// dialWS connects a WebSocket client to the test server, injecting the auth cookie.
func dialWS(t *testing.T, ts *httptest.Server, sessionID string) *websocket.Conn {
	t.Helper()

	url := "ws" + strings.TrimPrefix(ts.URL, "http")
	header := http.Header{}
	header.Set("Cookie", "session="+sessionID)

	conn, _, err := websocket.DefaultDialer.Dial(url, header)
	if err != nil {
		t.Fatalf("dial ws: %v", err)
	}
	return conn
}

// sendJSON writes a JSON message to the WebSocket.
func sendJSON(t *testing.T, conn *websocket.Conn, v interface{}) {
	t.Helper()
	if err := conn.WriteJSON(v); err != nil {
		t.Fatalf("send json: %v", err)
	}
}

// readMsg reads the next message, parses it as BaseMessage, and returns it.
func readMsg(t *testing.T, conn *websocket.Conn) BaseMessage {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read msg: %v", err)
	}
	var msg BaseMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		t.Fatalf("parse msg: %v (raw: %s)", err, string(data))
	}
	return msg
}

// readMsgOfType reads messages until it finds one matching the expected type.
// Returns the matching message. Times out after 5 seconds.
func readMsgOfType(t *testing.T, conn *websocket.Conn, expected MessageType) BaseMessage {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		conn.SetReadDeadline(deadline)
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read msg (expecting %s): %v", expected, err)
		}
		var msg BaseMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			t.Fatalf("parse msg: %v", err)
		}
		if msg.Type == expected {
			return msg
		}
		// Discard output messages that arrive while waiting for a specific type
	}
	t.Fatalf("timed out waiting for message type %s", expected)
	return BaseMessage{}
}

func TestMultiTerminalWS_CreateAndListSessions(t *testing.T) {
	_, ts, authSessionID := newTestServer(t)

	conn := dialWS(t, ts, authSessionID)
	defer conn.Close()

	// Create a session
	sendJSON(t, conn, wsMessage{
		Type: "create_session",
		Data: mustMarshal(wsCreateSessionData{
			SessionID: "sess-1",
			Rows:      24,
			Cols:      80,
			Name:      "Terminal 1",
		}),
	})

	// Wait for session_created
	created := readMsgOfType(t, conn, MessageTypeSessionCreated)
	if created.SessionID != "sess-1" {
		t.Fatalf("expected session ID sess-1, got %s", created.SessionID)
	}

	// List sessions
	sendJSON(t, conn, wsMessage{Type: "list_sessions"})

	listed := readMsgOfType(t, conn, MessageTypeSessionList)
	var listData SessionListMessage
	if err := json.Unmarshal(listed.Data, &listData); err != nil {
		t.Fatalf("parse session list: %v", err)
	}
	if len(listData.Sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(listData.Sessions))
	}
	if listData.Sessions[0].SessionID != "sess-1" {
		t.Fatalf("expected session ID sess-1, got %s", listData.Sessions[0].SessionID)
	}
	if listData.Sessions[0].Status != "running" {
		t.Fatalf("expected status running, got %s", listData.Sessions[0].Status)
	}
}

func TestMultiTerminalWS_ReconnectAndReattach(t *testing.T) {
	_, ts, authSessionID := newTestServer(t)

	// --- Connection 1: create a session ---
	conn1 := dialWS(t, ts, authSessionID)

	sendJSON(t, conn1, wsMessage{
		Type: "create_session",
		Data: mustMarshal(wsCreateSessionData{
			SessionID: "sess-reattach",
			Rows:      24,
			Cols:      80,
			Name:      "My Terminal",
		}),
	})

	// Wait for session_created
	readMsgOfType(t, conn1, MessageTypeSessionCreated)

	// Send some input so the process produces output (echo writes to PTY)
	sendJSON(t, conn1, wsMessage{
		Type:      "input",
		SessionID: "sess-reattach",
		Data:      mustMarshal(wsInputData{Data: "echo hello-reconnect\n"}),
	})

	// Give the PTY output reader time to buffer output
	time.Sleep(200 * time.Millisecond)

	// Disconnect (triggers orphan)
	conn1.Close()

	// Small delay for the server to process the disconnect
	time.Sleep(100 * time.Millisecond)

	// --- Connection 2: reconnect and reattach ---
	conn2 := dialWS(t, ts, authSessionID)
	defer conn2.Close()

	// List sessions — session should still exist (orphaned but alive)
	sendJSON(t, conn2, wsMessage{Type: "list_sessions"})

	listed := readMsgOfType(t, conn2, MessageTypeSessionList)
	var listData SessionListMessage
	if err := json.Unmarshal(listed.Data, &listData); err != nil {
		t.Fatalf("parse session list: %v", err)
	}
	if len(listData.Sessions) != 1 {
		t.Fatalf("expected 1 session in list, got %d", len(listData.Sessions))
	}
	if listData.Sessions[0].SessionID != "sess-reattach" {
		t.Fatalf("expected session sess-reattach, got %s", listData.Sessions[0].SessionID)
	}

	// Reattach to the session
	sendJSON(t, conn2, wsMessage{
		Type: "reattach_session",
		Data: mustMarshal(wsReattachSessionData{
			SessionID: "sess-reattach",
			Rows:      24,
			Cols:      80,
		}),
	})

	// Should receive session_reattached
	reattached := readMsgOfType(t, conn2, MessageTypeSessionReattached)
	if reattached.SessionID != "sess-reattach" {
		t.Fatalf("expected reattached session sess-reattach, got %s", reattached.SessionID)
	}

	// Should receive scrollback with buffered output (may or may not contain data depending on timing)
	// The scrollback message is always sent, even if empty — check we at least get it
	scrollback := readMsgOfType(t, conn2, MessageTypeScrollback)
	if scrollback.SessionID != "sess-reattach" {
		t.Fatalf("expected scrollback for sess-reattach, got %s", scrollback.SessionID)
	}
}

func TestMultiTerminalWS_ReattachNonexistentSession(t *testing.T) {
	_, ts, authSessionID := newTestServer(t)

	conn := dialWS(t, ts, authSessionID)
	defer conn.Close()

	// Try to reattach to a session that doesn't exist
	sendJSON(t, conn, wsMessage{
		Type: "reattach_session",
		Data: mustMarshal(wsReattachSessionData{
			SessionID: "nonexistent",
			Rows:      24,
			Cols:      80,
		}),
	})

	// Should receive an error message
	errMsg := readMsgOfType(t, conn, MessageTypeError)
	if errMsg.SessionID != "nonexistent" {
		t.Fatalf("expected error for nonexistent, got %s", errMsg.SessionID)
	}
}

func TestMultiTerminalWS_CloseSession(t *testing.T) {
	s, ts, authSessionID := newTestServer(t)

	conn := dialWS(t, ts, authSessionID)
	defer conn.Close()

	// Create a session
	sendJSON(t, conn, wsMessage{
		Type: "create_session",
		Data: mustMarshal(wsCreateSessionData{
			SessionID: "sess-close",
			Rows:      24,
			Cols:      80,
		}),
	})
	readMsgOfType(t, conn, MessageTypeSessionCreated)

	// Close the session
	sendJSON(t, conn, wsMessage{
		Type: "close_session",
		Data: mustMarshal(wsCloseSessionData{SessionID: "sess-close"}),
	})

	closed := readMsgOfType(t, conn, MessageTypeSessionClosed)
	if closed.SessionID != "sess-close" {
		t.Fatalf("expected closed session sess-close, got %s", closed.SessionID)
	}

	// Session should be gone from the manager
	if s.ptyManager.GetSession("sess-close") != nil {
		t.Fatal("expected session to be removed from manager after close")
	}
}

func TestMultiTerminalWS_EmptySessionList(t *testing.T) {
	_, ts, authSessionID := newTestServer(t)

	conn := dialWS(t, ts, authSessionID)
	defer conn.Close()

	// List sessions without creating any
	sendJSON(t, conn, wsMessage{Type: "list_sessions"})

	listed := readMsgOfType(t, conn, MessageTypeSessionList)
	var listData SessionListMessage
	if err := json.Unmarshal(listed.Data, &listData); err != nil {
		t.Fatalf("parse session list: %v", err)
	}
	if len(listData.Sessions) != 0 {
		t.Fatalf("expected 0 sessions, got %d", len(listData.Sessions))
	}
}

func TestMultiTerminalWS_DisconnectOrphansSessionsNotClose(t *testing.T) {
	s, ts, authSessionID := newTestServer(t)

	conn := dialWS(t, ts, authSessionID)

	// Create a session
	sendJSON(t, conn, wsMessage{
		Type: "create_session",
		Data: mustMarshal(wsCreateSessionData{
			SessionID: "sess-orphan",
			Rows:      24,
			Cols:      80,
		}),
	})
	readMsgOfType(t, conn, MessageTypeSessionCreated)

	// Disconnect
	conn.Close()
	time.Sleep(100 * time.Millisecond)

	// Session should still exist in the manager (orphaned, not closed)
	if s.ptyManager.GetSession("sess-orphan") == nil {
		t.Fatal("expected session to survive disconnect (orphaned)")
	}

	// Verify session appears in active sessions list
	active := s.ptyManager.GetActiveSessions()
	if len(active) != 1 {
		t.Fatalf("expected 1 active session, got %d", len(active))
	}
	if active[0].ID != "sess-orphan" {
		t.Fatalf("expected sess-orphan in active list, got %s", active[0].ID)
	}
}

func TestMultiTerminalWS_ListSessionsIsUserScoped(t *testing.T) {
	s, ts, authSessionID := newTestServer(t)

	// Create a session for another user directly in the manager.
	_, err := s.ptyManager.CreateSessionWithID("sess-other-user", "other-user", 24, 80, "")
	if err != nil {
		t.Fatalf("failed to create other-user session: %v", err)
	}

	conn := dialWS(t, ts, authSessionID)
	defer conn.Close()

	// Create an authenticated user's own session.
	sendJSON(t, conn, wsMessage{
		Type: "create_session",
		Data: mustMarshal(wsCreateSessionData{
			SessionID: "sess-owned",
			Rows:      24,
			Cols:      80,
		}),
	})
	readMsgOfType(t, conn, MessageTypeSessionCreated)

	sendJSON(t, conn, wsMessage{Type: "list_sessions"})
	listed := readMsgOfType(t, conn, MessageTypeSessionList)

	var listData SessionListMessage
	if err := json.Unmarshal(listed.Data, &listData); err != nil {
		t.Fatalf("parse session list: %v", err)
	}
	if len(listData.Sessions) != 1 {
		t.Fatalf("expected 1 scoped session, got %d", len(listData.Sessions))
	}
	if listData.Sessions[0].SessionID != "sess-owned" {
		t.Fatalf("expected only sess-owned, got %s", listData.Sessions[0].SessionID)
	}
}

func TestMultiTerminalWS_CloseSessionRejectsOtherUserSession(t *testing.T) {
	s, ts, authSessionID := newTestServer(t)

	// Create a session for another user directly in the manager.
	_, err := s.ptyManager.CreateSessionWithID("sess-other-user", "other-user", 24, 80, "")
	if err != nil {
		t.Fatalf("failed to create other-user session: %v", err)
	}

	conn := dialWS(t, ts, authSessionID)
	defer conn.Close()

	sendJSON(t, conn, wsMessage{
		Type: "close_session",
		Data: mustMarshal(wsCloseSessionData{SessionID: "sess-other-user"}),
	})

	errMsg := readMsgOfType(t, conn, MessageTypeError)
	if errMsg.SessionID != "sess-other-user" {
		t.Fatalf("expected error for sess-other-user, got %s", errMsg.SessionID)
	}

	// Session should still exist because close was rejected.
	if s.ptyManager.GetSession("sess-other-user") == nil {
		t.Fatal("expected other-user session to remain after unauthorized close attempt")
	}
}

// mustMarshal marshals v to json.RawMessage, panicking on error.
func mustMarshal(v interface{}) json.RawMessage {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return data
}
