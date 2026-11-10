package server

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/persistence"
	"github.com/workspace/vm-agent/internal/pty"
)

// State-machine audit D3. The agent and both terminal WebSocket handlers used to
// upsert the workspace runtime with status "running" before the reconnect check,
// and the upsert overwrites every status except evicted. A browser opening a
// WebSocket therefore turned a stopped or errored workspace back into "running".
// These tests drive the real handlers (rule 62): each dials the handler and then
// reads the runtime the handler's own upsert produced.

const attachWorkspaceID = "WS_ATTACH"

type attachHandler struct {
	name    string
	handler func(*Server) http.HandlerFunc
}

var attachHandlers = []attachHandler{
	{"agent_ws.go handleAgentWS", func(s *Server) http.HandlerFunc { return s.handleAgentWS }},
	{"websocket.go handleTerminalWS", func(s *Server) http.HandlerFunc { return s.handleTerminalWS }},
	{"websocket.go handleMultiTerminalWS", func(s *Server) http.HandlerFunc { return s.handleMultiTerminalWS }},
}

func newAttachTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	cfg := &config.Config{
		AllowedOrigins:             []string{"*"},
		WSReadBufferSize:           4096,
		WSWriteBufferSize:          4096,
		DefaultShell:               "/bin/sh",
		DefaultRows:                24,
		DefaultCols:                80,
		WorkspaceDir:               t.TempDir(),
		TerminalWSMaxMessageBytes:  config.DefaultTerminalWSMaxMessageBytes,
		TerminalWSReadTimeout:      config.DefaultTerminalWSReadTimeout,
		TerminalWSPingInterval:     config.DefaultTerminalWSPingInterval,
		TerminalWSMessageRate:      config.DefaultTerminalWSMessageRate,
		TerminalWSMessageBurst:     config.DefaultTerminalWSMessageBurst,
		TerminalSessionIDMaxLength: config.DefaultTerminalSessionIDMaxLength,
	}
	sm := auth.NewSessionManager("session", false, time.Hour)
	sess, err := sm.CreateSession(&auth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{Subject: "test-user"},
		Workspace:        attachWorkspaceID,
	})
	if err != nil {
		t.Fatalf("create auth session: %v", err)
	}
	ptm := pty.NewManager(pty.ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		BufferSize:   4096,
	})
	t.Cleanup(ptm.CloseAllSessions)
	s, _ := newServerWithoutReporter(t)
	s.config = cfg
	s.sessionManager = sm
	s.ptyManager = ptm
	if s.done == nil {
		s.done = make(chan struct{})
	}
	return s, sess.ID
}

// attach dials the handler as a browser would. The handler's upsert runs before the
// upgrade, so once the dial returns (accepted or refused) the runtime reflects it.
func attach(t *testing.T, s *Server, h attachHandler, cookie string) {
	t.Helper()
	ts := httptest.NewServer(h.handler(s))
	t.Cleanup(ts.Close)
	header := http.Header{}
	header.Set("Cookie", "session="+cookie)
	header.Set("X-SAM-Workspace-Id", attachWorkspaceID)
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "?sessionId=sess-attach"
	conn, _, err := websocket.DefaultDialer.Dial(url, header)
	if err == nil {
		_ = conn.Close()
	}
}

func runtimeStatus(t *testing.T, s *Server) string {
	t.Helper()
	runtime, ok := s.getWorkspaceRuntime(attachWorkspaceID)
	if !ok {
		t.Fatal("expected the workspace runtime to exist after the attach")
	}
	s.workspaceMu.RLock()
	defer s.workspaceMu.RUnlock()
	return runtime.Status
}

func TestWebSocketAttachKeepsExistingRuntimeStatus(t *testing.T) {
	for _, h := range attachHandlers {
		for _, status := range []string{"stopped", "error", "recovery"} {
			t.Run(h.name+"/"+status, func(t *testing.T) {
				s, cookie := newAttachTestServer(t)
				s.upsertWorkspaceRuntime(attachWorkspaceID, "octo/repo", "main", status, "ws-token",
					workspaceRuntimeOpts{ProjectID: "proj-1", Lightweight: lightweightOpt(true)})
				seededAt := runtimeUpdatedAt(t, s)
				time.Sleep(2 * time.Millisecond)

				attach(t, s, h, cookie)

				assertAttachKeptRuntime(t, s, status, seededAt)
			})
		}
	}
}

func runtimeUpdatedAt(t *testing.T, s *Server) time.Time {
	t.Helper()
	runtime, ok := s.getWorkspaceRuntime(attachWorkspaceID)
	if !ok {
		t.Fatal("expected the seeded workspace runtime")
	}
	s.workspaceMu.RLock()
	defer s.workspaceMu.RUnlock()
	return runtime.UpdatedAt
}

// assertAttachKeptRuntime checks the attach left status and Lightweight alone. The
// liveness half: the upsert's update branch always advances UpdatedAt, so an
// UpdatedAt past the seed proves the handler's own upsert ran on this runtime (a
// refused dial that never reached it would leave the seeded value).
func assertAttachKeptRuntime(t *testing.T, s *Server, status string, seededAt time.Time) {
	t.Helper()
	runtime, _ := s.getWorkspaceRuntime(attachWorkspaceID)
	s.workspaceMu.RLock()
	defer s.workspaceMu.RUnlock()
	if !runtime.UpdatedAt.After(seededAt) {
		t.Fatal("the handler did not reach the runtime upsert")
	}
	if runtime.Status != status {
		t.Fatalf("attaching a browser changed the workspace status from %q to %q", status, runtime.Status)
	}
	if !runtime.Lightweight {
		t.Fatal("attaching a browser cleared the runtime's Lightweight flag")
	}
}

// Control: a runtime missing after an agent restart is still rebuilt as running, as
// it was before the fix. Without this, "never pass a status" would also pass above.
func TestWebSocketAttachRebuildsMissingRuntimeAsRunning(t *testing.T) {
	for _, h := range attachHandlers {
		t.Run(h.name, func(t *testing.T) {
			s, cookie := newAttachTestServer(t)

			attach(t, s, h, cookie)

			if got := runtimeStatus(t, s); got != "running" {
				t.Fatalf("expected a missing runtime to be rebuilt as running, got %q", got)
			}
		})
	}
}

// A runtime rebuilt for a workspace persisted as evicted stays evicted after an attach,
// whatever CreateStatus says. Two layers hold this: hydration overrides CreateStatus
// in the create branch, and the reconnect gate re-reads the persisted flag
// (refreshWorkspaceEvictionState). Removing either one alone leaves this green; the
// test guards the user-visible outcome, not the ordering inside the upsert.
func TestWebSocketAttachRebuildsEvictedRuntimeAsEvicted(t *testing.T) {
	for _, h := range attachHandlers {
		t.Run(h.name, func(t *testing.T) {
			s, cookie := newAttachTestServer(t)
			store, err := persistence.Open(filepath.Join(t.TempDir(), "attach.db"))
			if err != nil {
				t.Fatalf("open store: %v", err)
			}
			t.Cleanup(func() { _ = store.Close() })
			if err := store.UpsertWorkspaceMetadata(persistence.WorkspaceMetadata{
				WorkspaceID: attachWorkspaceID, ContainerLabelVal: "/workspace/evicted", Evicted: true,
			}); err != nil {
				t.Fatalf("persist metadata: %v", err)
			}
			s.store = store

			attach(t, s, h, cookie)

			if got := runtimeStatus(t, s); got != "evicted" {
				t.Fatalf("expected a rebuilt evicted runtime to stay evicted, got %q", got)
			}
		})
	}
}
