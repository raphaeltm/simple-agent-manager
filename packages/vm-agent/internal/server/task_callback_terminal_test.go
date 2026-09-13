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

// terminalCallbackFixture builds a node shaped like the one from the 2026-09-13
// incident: a live node running a co-tenant workspace with its own message
// reporter, talking to a control plane that is healthy for every callback EXCEPT
// the one under test.
//
// terminalSegment is the last path segment that answers with the terminal status
// ("callback" for the task status callback, "heartbeat", "ready",
// "node-acp-heartbeat"). Everything else answers 200, because in production the
// node heartbeat was succeeding at the moment the task callback returned 410.
//
// Returns the server, a per-path-segment request counter, and the co-tenant
// workspace ID whose reporter must survive a resource-scoped terminal status.
func terminalCallbackFixture(
	t *testing.T,
	terminalSegment string,
	status int,
	responseBody string,
) (*Server, func(string) int, string) {
	t.Helper()

	var mu sync.Mutex
	byPath := map[string]int{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		segments := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		segment := segments[len(segments)-1]

		mu.Lock()
		byPath[segment]++
		mu.Unlock()

		if segment == terminalSegment {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(responseBody))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(ts.Close)

	s, _ := newServerWithoutReporter(t)
	s.config.ControlPlaneURL = ts.URL
	s.config.CallbackToken = "callback-token"
	s.config.HeartbeatInterval = time.Minute
	s.config.HTTPCallbackTimeout = 5 * time.Second
	s.callbackToken = "callback-token"
	s.httpClient = ts.Client()
	s.errorReporter = newTestErrorReporter()

	// The innocent bystander: a second workspace on the same node, mid-task.
	const coTenantID = "ws-co-tenant"
	coTenant := s.getOrCreateReporter(coTenantID, "proj-1", "sess-co-tenant")
	if coTenant == nil {
		t.Fatal("fixture: expected a co-tenant reporter before the terminal callback")
	}
	t.Cleanup(coTenant.Shutdown)

	count := func(segment string) int {
		mu.Lock()
		defer mu.Unlock()
		return byPath[segment]
	}
	return s, count, coTenantID
}

func taskCallbackURL(s *Server) string {
	return strings.TrimRight(s.config.ControlPlaneURL, "/") +
		"/api/projects/proj-1/tasks/task-1/status/callback"
}

// DIVERGENCE CASE — the 2026-09-13 incident.
//
// A task-status callback returning a terminal status must not shut down anything
// beyond that callback. The production trigger was a 410 from the workspace
// compare-and-swap fence (apps/api/src/routes/workspaces/_helpers.ts) after the
// orchestrator cancelled and re-dispatched the task; the node was healthy and
// still running two other workspaces. Pre-fix this latched node-wide state and
// the node went silent for the rest of its life. See `.claude/rules/75`.
func TestTaskCallbackTerminalStatusDoesNotLatchNodeCallbacks(t *testing.T) {
	for _, status := range []int{
		http.StatusUnauthorized,
		http.StatusForbidden,
		http.StatusNotFound,
		http.StatusGone,
	} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			s, count, coTenantID := terminalCallbackFixture(t, "callback", status,
				`{"error":"GONE","message":"Workspace callback state changed; callback resource is gone"}`)

			s.postTaskCallback(taskCallbackURL(s), "task-1", "callback-token",
				map[string]interface{}{"status": "completed"})

			// Liveness: the callback really was sent and really saw the status, so
			// a passing test cannot mean the POST was silently skipped.
			if got := count("callback"); got != 1 {
				t.Fatalf("expected the task callback to be attempted once, got %d", got)
			}

			if s.controlPlaneCallbacksStopped() {
				t.Fatal("a task-scoped terminal status must not latch node-wide callbacks")
			}

			// 1. The node heartbeat must still reach the control plane. Losing this
			//    is what made a working node show up as `unhealthy`.
			s.sendNodeHeartbeat()
			if got := count("heartbeat"); got != 1 {
				t.Fatalf("expected the node heartbeat to still be sent, got %d requests", got)
			}

			// 2. The co-tenant workspace's reporter must still be handed out. Losing
			//    this is what silently truncated a co-tenant task's chat transcript.
			if got := s.getOrCreateReporter(coTenantID, "proj-1", "sess-co-tenant"); got == nil {
				t.Fatal("the co-tenant reporter must survive a task-scoped terminal status")
			}

			// 3. A workspace created afterwards must still get a reporter. Losing
			//    this is why the re-dispatched task's chat stayed completely empty.
			later := s.getOrCreateReporter("ws-created-after", "proj-1", "sess-later")
			if later == nil {
				t.Fatal("a workspace created after a task-scoped terminal status must still get a reporter")
			}
			later.Shutdown()
		})
	}
}

// DIVERGENCE CASE — the second trigger of the same defect.
//
// The ACP heartbeat is addressed per PROJECT and returns 410 when any single
// workspace on the node is deleted (node-acp-heartbeat.ts terminalResourceResponse
// with kind 'workspace'), or 403 for a project the token is not bound to. Neither
// proves the node is gone.
func TestAcpHeartbeatTerminalStatusDoesNotLatchNodeCallbacks(t *testing.T) {
	s, count, coTenantID := terminalCallbackFixture(t, "node-acp-heartbeat", http.StatusGone,
		`{"error":"GONE","message":"Workspace is deleted; ACP heartbeat resource is gone"}`)
	s.workspaces["ws-co-tenant"] = &WorkspaceRuntime{
		ID: "ws-co-tenant", ProjectID: "proj-1", Status: "running",
	}

	s.sendAcpHeartbeats()

	if got := count("node-acp-heartbeat"); got != 1 {
		t.Fatalf("expected the ACP heartbeat to be attempted once, got %d", got)
	}
	if s.controlPlaneCallbacksStopped() {
		t.Fatal("a workspace-scoped ACP heartbeat status must not latch node-wide callbacks")
	}

	s.sendNodeHeartbeat()
	if got := count("heartbeat"); got != 1 {
		t.Fatalf("expected the node heartbeat to still be sent, got %d requests", got)
	}
	if got := s.getOrCreateReporter(coTenantID, "proj-1", "sess-co-tenant"); got == nil {
		t.Fatal("the co-tenant reporter must survive a workspace-scoped ACP heartbeat status")
	}
}

// CONVERGENCE CONTROL — without this, the suite would pass with the whole guard
// deleted. A terminal status on the node's OWN heartbeat endpoint still means the
// node row is gone and must still stop every callback. This is PR #1922's
// zombie-callback-storm protection and it is deliberately unchanged.
func TestNodeHeartbeatTerminalStatusStillLatchesNodeCallbacks(t *testing.T) {
	for _, status := range []int{
		http.StatusUnauthorized,
		http.StatusForbidden,
		http.StatusNotFound,
		http.StatusGone,
	} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			s, count, coTenantID := terminalCallbackFixture(t, "heartbeat", status,
				`{"error":"GONE","message":"Node is deleted; callback resource is gone"}`)

			s.sendNodeHeartbeat()

			if got := count("heartbeat"); got != 1 {
				t.Fatalf("expected the node heartbeat to be attempted once, got %d", got)
			}
			if !s.controlPlaneCallbacksStopped() {
				t.Fatal("a node-scoped terminal status must still latch node-wide callbacks")
			}

			// The latch must still stop subsequent callbacks and every reporter.
			s.sendNodeHeartbeat()
			if got := count("heartbeat"); got != 1 {
				t.Fatalf("expected no heartbeat retry after the node-scoped latch, got %d", got)
			}
			if got := s.getOrCreateReporter(coTenantID, "proj-1", "sess-co-tenant"); got != nil {
				t.Fatal("expected the co-tenant reporter to be withheld after the node is gone")
			}
			if later := s.getOrCreateReporter("ws-created-after", "proj-1", "sess-later"); later != nil {
				later.Shutdown()
				t.Fatal("expected no new reporters after the node is gone")
			}
		})
	}
}

// CONVERGENCE CONTROL — the node-ready callback is node-scoped for the same
// reason and keeps its latch authority.
func TestNodeReadyTerminalStatusStillLatchesNodeCallbacks(t *testing.T) {
	s, count, _ := terminalCallbackFixture(t, "ready", http.StatusGone,
		`{"error":"GONE","message":"Node is destroyed; callback resource is gone"}`)

	s.sendNodeReady()

	if got := count("ready"); got != 1 {
		t.Fatalf("expected the node ready callback to be attempted once, got %d", got)
	}
	if !s.controlPlaneCallbacksStopped() {
		t.Fatal("a node-scoped ready callback status must still latch node-wide callbacks")
	}
}

// A latched node still skips task callbacks — the existing short-circuit in
// postTaskCallback is unchanged by the scoping fix.
func TestLatchedNodeSkipsSubsequentTaskCallbacks(t *testing.T) {
	s, count, _ := terminalCallbackFixture(t, "heartbeat", http.StatusGone,
		`{"error":"GONE","message":"Node is deleted; callback resource is gone"}`)

	s.sendNodeHeartbeat()
	if !s.controlPlaneCallbacksStopped() {
		t.Fatal("fixture: expected the node-scoped heartbeat to latch")
	}

	s.postTaskCallback(taskCallbackURL(s), "task-1", "callback-token",
		map[string]interface{}{"status": "completed"})

	if got := count("callback"); got != 0 {
		t.Fatalf("expected task callbacks to be skipped once latched, got %d", got)
	}
}

// The scope enum is the load-bearing discriminator; assert it directly so a
// future refactor cannot quietly collapse the two scopes into one.
func TestHandleTerminalControlPlaneCallbackLatchesOnlyNodeScope(t *testing.T) {
	t.Parallel()

	resourceScoped := &Server{
		config:           &config.Config{NodeID: "node-test"},
		messageReporters: make(map[string]*messagereport.Reporter),
		done:             make(chan struct{}),
	}
	resourceScoped.handleTerminalControlPlaneCallback(
		"task_callback", callbackScopeResource, http.StatusGone, "gone")
	if resourceScoped.controlPlaneCallbacksStopped() {
		t.Fatal("callbackScopeResource must not latch")
	}

	nodeScoped := &Server{
		config:           &config.Config{NodeID: "node-test"},
		messageReporters: make(map[string]*messagereport.Reporter),
		done:             make(chan struct{}),
	}
	nodeScoped.handleTerminalControlPlaneCallback(
		"node_heartbeat", callbackScopeNode, http.StatusGone, "gone")
	if !nodeScoped.controlPlaneCallbacksStopped() {
		t.Fatal("callbackScopeNode must latch")
	}
}
