package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
)

func TestBootLogWSOriginPolicy(t *testing.T) {
	sm := auth.NewSessionManager("session", false, time.Hour)
	defer sm.Stop()
	session, err := sm.CreateSession(&auth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{Subject: "user-1"},
		Workspace:        "WS_TEST",
	})
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{
		config: &config.Config{
			AllowedOrigins:    []string{"https://app.example.com"},
			WorkspaceID:       "WS_TEST",
			WSReadBufferSize:  4096,
			WSWriteBufferSize: 4096,
		},
		sessionManager:      sm,
		bootLogBroadcasters: NewBootLogBroadcasterManager(),
	}

	previewRecorder := httptest.NewRecorder()
	previewRequest := httptest.NewRequest(http.MethodGet, "/boot-log/ws", nil)
	previewRequest.Header.Set("Origin", "https://ws-ws-test--3000.example.com")
	s.handleBootLogWS(previewRecorder, previewRequest)
	if previewRecorder.Code != http.StatusForbidden {
		t.Fatalf("preview origin status = %d, want 403", previewRecorder.Code)
	}

	testServer := httptest.NewServer(http.HandlerFunc(s.handleBootLogWS))
	defer testServer.Close()
	header := http.Header{}
	header.Set("Cookie", "session="+session.ID)
	header.Set("Origin", "https://app.example.com")
	conn, _, err := websocket.DefaultDialer.Dial(
		"ws"+strings.TrimPrefix(testServer.URL, "http"),
		header,
	)
	if err != nil {
		t.Fatalf("exact app origin failed to connect: %v", err)
	}
	_ = conn.Close()
}

// TestNilBootLogBroadcasterBroadcast verifies that calling Broadcast on a nil
// *BootLogBroadcaster does not panic. This is the exact crash scenario from
// the production SIGSEGV: a nil *BootLogBroadcaster stored in a non-nil
// Broadcaster interface value.
func TestNilBootLogBroadcasterBroadcast(t *testing.T) {
	t.Parallel()
	var b *BootLogBroadcaster // nil pointer
	// Must not panic
	b.Broadcast("agent_install", "error", "install failed", "ENOTEMPTY")
}

// TestNilBootLogBroadcasterAddClient verifies that AddClient is nil-safe.
func TestNilBootLogBroadcasterAddClient(t *testing.T) {
	t.Parallel()
	var b *BootLogBroadcaster
	// Must not panic (conn is nil too, but we never dereference it)
	b.AddClient(nil)
}

// TestNilBootLogBroadcasterRemoveClient verifies that RemoveClient is nil-safe.
func TestNilBootLogBroadcasterRemoveClient(t *testing.T) {
	t.Parallel()
	var b *BootLogBroadcaster
	b.RemoveClient(nil)
}

// TestNilBootLogBroadcasterMarkComplete verifies that MarkComplete is nil-safe.
func TestNilBootLogBroadcasterMarkComplete(t *testing.T) {
	t.Parallel()
	var b *BootLogBroadcaster
	b.MarkComplete()
}

// TestNilBroadcasterViaInterface verifies the exact production crash path:
// a nil *BootLogBroadcaster stored inside a non-nil interface value.
// In Go, an interface holding a nil concrete pointer is itself non-nil,
// so the method dispatch reaches the receiver — which must handle nil.
func TestNilBroadcasterViaInterface(t *testing.T) {
	t.Parallel()

	var concrete *BootLogBroadcaster // nil
	// Store in a non-nil interface — this is how the Reporter holds it.
	type broadcaster interface {
		Broadcast(step, status, message string, detail ...string)
	}
	var iface broadcaster = concrete // non-nil interface, nil concrete

	// Must not panic
	iface.Broadcast("agent_install", "error", "install failed")
}
