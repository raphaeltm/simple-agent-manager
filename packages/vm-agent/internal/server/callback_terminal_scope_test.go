package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/messagereport"
)

// A terminal answer about one project or one task must leave the rest of the
// node's control-plane delivery running. Regression for 2026-09-25, when a 410
// for one drained project's ACP heartbeat silenced heartbeats, error reports and
// every transcript on a live fourteen-workspace node for seven hours.

const (
	drainedProjectHeartbeatPath = "/api/projects/proj-drained/node-acp-heartbeat"
	liveProjectHeartbeatPath    = "/api/projects/proj-live/node-acp-heartbeat"
	nodeHeartbeatPath           = "/api/nodes/node-1/heartbeat"
	liveWorkspaceMessagesPath   = "/api/workspaces/ws-live/messages"
)

var terminalCallbackStatuses = []int{
	http.StatusUnauthorized,
	http.StatusForbidden,
	http.StatusNotFound,
	http.StatusGone,
}

// fakeControlPlane answers one path with a terminal status, the node heartbeat
// with a healthy body, and everything else with 204. It counts every request.
type fakeControlPlane struct {
	*httptest.Server
	mu       sync.Mutex
	requests map[string]int
}

func newFakeControlPlane(t *testing.T, terminalPath string, terminalStatus int) *fakeControlPlane {
	t.Helper()
	cp := &fakeControlPlane{requests: map[string]int{}}
	cp.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cp.mu.Lock()
		cp.requests[r.URL.Path]++
		cp.mu.Unlock()
		switch {
		case r.URL.Path == terminalPath:
			w.WriteHeader(terminalStatus)
			_, _ = w.Write([]byte(`{"error":"GONE","message":"resource is gone"}`))
		case strings.HasSuffix(r.URL.Path, "/heartbeat"):
			_, _ = w.Write([]byte(`{"status":"running","healthStatus":"healthy"}`))
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(cp.Close)
	return cp
}

func (cp *fakeControlPlane) count(path string) int {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return cp.requests[path]
}

// newTwoProjectNode hosts a drained project and a live one, the shape of the
// incident node the moment its last proj-drained workspace was cleaned up.
func newTwoProjectNode(controlPlaneURL string) *Server {
	return &Server{
		config: &config.Config{
			NodeID:              "node-1",
			ControlPlaneURL:     controlPlaneURL,
			CallbackToken:       "node-token",
			HTTPCallbackTimeout: 5 * time.Second,
		},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-drained": {ID: "ws-drained", ProjectID: "proj-drained", Status: "running"},
			"ws-live":    {ID: "ws-live", ProjectID: "proj-live", Status: "running"},
		},
		callbackToken:    "node-token",
		errorReporter:    newTestErrorReporter(),
		messageReporters: make(map[string]*messagereport.Reporter),
		done:             make(chan struct{}),
	}
}

func startLiveWorkspaceReporter(t *testing.T, s *Server, controlPlaneURL string) *messagereport.Reporter {
	t.Helper()
	_, db := openTestSQLiteDB(t)
	reporter, err := messagereport.New(db, messagereport.Config{
		BatchMaxWait: 10 * time.Millisecond,
		Endpoint:     controlPlaneURL,
		WorkspaceID:  "ws-live",
		ProjectID:    "proj-live",
		SessionID:    "session-live",
	})
	if err != nil {
		t.Fatalf("create message reporter: %v", err)
	}
	reporter.SetToken("workspace-token")
	t.Cleanup(reporter.Shutdown)
	s.messageReporters["ws-live"] = reporter
	return reporter
}

func waitForRequest(t *testing.T, cp *fakeControlPlane, path string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for cp.count(path) == 0 {
		if time.Now().After(deadline) {
			t.Fatalf("no request reached %s", path)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestTerminalProjectHeartbeatLeavesNodeDeliveryRunning(t *testing.T) {
	for _, status := range terminalCallbackStatuses {
		t.Run(http.StatusText(status), func(t *testing.T) {
			cp := newFakeControlPlane(t, drainedProjectHeartbeatPath, status)
			s := newTwoProjectNode(cp.URL)
			reporter := startLiveWorkspaceReporter(t, s, cp.URL)

			s.sendAcpHeartbeats()
			s.sendAcpHeartbeats()
			s.sendNodeHeartbeat()
			if err := reporter.Enqueue(messagereport.Message{
				MessageID: "msg-after-terminal-project",
				SessionID: "session-live",
				Role:      "assistant",
				Content:   "still working",
			}); err != nil {
				t.Fatalf("enqueue: %v", err)
			}
			waitForRequest(t, cp, liveWorkspaceMessagesPath)

			if got := cp.count(drainedProjectHeartbeatPath); got != 2 {
				t.Fatalf("drained project heartbeats = %d, want 2 (the terminal status was served)", got)
			}
			if s.controlPlaneCallbacksStopped() {
				t.Fatal("a terminal status for one project disowned the whole node")
			}
			if got := cp.count(liveProjectHeartbeatPath); got != 2 {
				t.Fatalf("live project heartbeats = %d, want 2", got)
			}
			if got := cp.count(nodeHeartbeatPath); got != 1 {
				t.Fatalf("node heartbeats = %d, want 1", got)
			}
		})
	}
}

func TestTerminalTaskCallbackLeavesNodeDeliveryRunning(t *testing.T) {
	for _, status := range terminalCallbackStatuses {
		t.Run(http.StatusText(status), func(t *testing.T) {
			const endedTaskPath = "/api/projects/proj-live/tasks/task-ended/status/callback"
			const liveTaskPath = "/api/projects/proj-live/tasks/task-live/status/callback"
			cp := newFakeControlPlane(t, endedTaskPath, status)
			s := newTwoProjectNode(cp.URL)

			s.postTaskCallback(cp.URL+endedTaskPath, "task-ended", "workspace-token",
				map[string]interface{}{"executionStep": "awaiting_followup"})
			s.postTaskCallback(cp.URL+liveTaskPath, "task-live", "workspace-token",
				map[string]interface{}{"executionStep": "awaiting_followup"})
			s.sendNodeHeartbeat()

			if got := cp.count(endedTaskPath); got != 1 {
				t.Fatalf("ended task callbacks = %d, want 1 (the terminal status was served)", got)
			}
			if s.controlPlaneCallbacksStopped() {
				t.Fatal("a terminal status for one task disowned the whole node")
			}
			if got := cp.count(liveTaskPath); got != 1 {
				t.Fatalf("live task callbacks = %d, want 1", got)
			}
			if got := cp.count(nodeHeartbeatPath); got != 1 {
				t.Fatalf("node heartbeats = %d, want 1", got)
			}
		})
	}
}

// Control: the node's own heartbeat is the authority on whether the node was
// disowned, and a terminal answer to it still stops every callback, including
// the per-project ACP heartbeats this change stopped latching on.
func TestTerminalNodeHeartbeatStillDisownsTheNode(t *testing.T) {
	for _, status := range terminalCallbackStatuses {
		t.Run(http.StatusText(status), func(t *testing.T) {
			cp := newFakeControlPlane(t, nodeHeartbeatPath, status)
			s := newTwoProjectNode(cp.URL)

			s.sendNodeHeartbeat()
			s.sendAcpHeartbeats()

			if !s.controlPlaneCallbacksStopped() {
				t.Fatal("a terminal node heartbeat must disown the node")
			}
			if got := cp.count(liveProjectHeartbeatPath); got != 0 {
				t.Fatalf("ACP heartbeats after the node was disowned = %d, want 0", got)
			}
		})
	}
}
