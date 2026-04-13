package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/messagereport"
	"github.com/workspace/vm-agent/internal/pty"
)

func TestActiveProjectIDs_ReturnsUniqueRunningProjects(t *testing.T) {
	s := &Server{
		config: &config.Config{NodeID: "node-1"},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-1": {ID: "ws-1", ProjectID: "proj-a", Status: "running"},
			"ws-2": {ID: "ws-2", ProjectID: "proj-a", Status: "running"},  // duplicate project
			"ws-3": {ID: "ws-3", ProjectID: "proj-b", Status: "running"},
			"ws-4": {ID: "ws-4", ProjectID: "proj-c", Status: "stopped"},  // not running
			"ws-5": {ID: "ws-5", ProjectID: "", Status: "running"},         // no project
			"ws-6": {ID: "ws-6", ProjectID: "proj-d", Status: "recovery"}, // recovery counts
		},
		done: make(chan struct{}),
	}

	ids := s.activeProjectIDs()
	if len(ids) != 3 {
		t.Fatalf("expected 3 unique project IDs, got %d: %v", len(ids), ids)
	}

	seen := make(map[string]bool)
	for _, id := range ids {
		seen[id] = true
	}
	for _, expected := range []string{"proj-a", "proj-b", "proj-d"} {
		if !seen[expected] {
			t.Errorf("expected project ID %q in results", expected)
		}
	}
}

func TestActiveProjectIDs_EmptyWhenNoWorkspaces(t *testing.T) {
	s := &Server{
		config:     &config.Config{NodeID: "node-1"},
		workspaces: map[string]*WorkspaceRuntime{},
		done:       make(chan struct{}),
	}

	ids := s.activeProjectIDs()
	if len(ids) != 0 {
		t.Fatalf("expected 0 project IDs, got %d", len(ids))
	}
}

func TestSendAcpHeartbeats_PostsToCorrectEndpoint(t *testing.T) {
	var mu sync.Mutex
	received := make(map[string]string) // projectID → nodeID

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Expect POST /api/projects/:projectId/node-acp-heartbeat
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}

		auth := r.Header.Get("Authorization")
		if auth != "Bearer test-token" {
			t.Errorf("expected Bearer test-token, got %s", auth)
		}

		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}

		// Extract projectId from URL path
		// URL: /api/projects/{projectId}/node-acp-heartbeat
		// We'll just capture everything
		mu.Lock()
		received[r.URL.Path] = body["nodeId"]
		mu.Unlock()

		w.WriteHeader(http.StatusNoContent)
	}))
	defer ts.Close()

	s := &Server{
		config: &config.Config{
			NodeID:               "node-test",
			ControlPlaneURL:      ts.URL,
			ACPHeartbeatInterval: 100 * time.Millisecond,
			HTTPCallbackTimeout:  5 * time.Second,
		},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-1": {ID: "ws-1", ProjectID: "proj-a", Status: "running"},
			"ws-2": {ID: "ws-2", ProjectID: "proj-b", Status: "running"},
		},
		callbackToken: "test-token",
		httpClient:    &http.Client{Timeout: 5 * time.Second},
		done:          make(chan struct{}),
	}

	s.sendAcpHeartbeats()

	mu.Lock()
	defer mu.Unlock()

	if len(received) != 2 {
		t.Fatalf("expected 2 heartbeat requests, got %d", len(received))
	}

	expectedPaths := map[string]bool{
		"/api/projects/proj-a/node-acp-heartbeat": true,
		"/api/projects/proj-b/node-acp-heartbeat": true,
	}
	for path, nodeID := range received {
		if !expectedPaths[path] {
			t.Errorf("unexpected path: %s", path)
		}
		if nodeID != "node-test" {
			t.Errorf("expected nodeId node-test, got %s", nodeID)
		}
	}
}

func TestStartAcpHeartbeatReporter_StopsOnDoneChannel(t *testing.T) {
	requestCount := 0
	var mu sync.Mutex

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requestCount++
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer ts.Close()

	ptyManager := pty.NewManager(pty.ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		WorkDir:      "/tmp",
		BufferSize:   1024,
	})

	s := &Server{
		config: &config.Config{
			NodeID:               "node-test",
			ControlPlaneURL:      ts.URL,
			ACPHeartbeatInterval: 50 * time.Millisecond,
			HTTPCallbackTimeout:  5 * time.Second,
		},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-1": {ID: "ws-1", ProjectID: "proj-a", Status: "running"},
		},
		ptyManager:       ptyManager,
		agentSessions:    agentsessions.NewManager(),
		callbackToken:    "test-token",
		httpClient:       &http.Client{Timeout: 5 * time.Second},
		messageReporters: make(map[string]*messagereport.Reporter),
		done:             make(chan struct{}),
	}

	s.startAcpHeartbeatReporter()

	// Wait for a few ticks
	time.Sleep(200 * time.Millisecond)

	// Stop the goroutine
	close(s.done)

	// Give it time to exit
	time.Sleep(100 * time.Millisecond)

	mu.Lock()
	count := requestCount
	mu.Unlock()

	if count == 0 {
		t.Error("expected at least one heartbeat request before stop")
	}

	// Record count after stop
	time.Sleep(200 * time.Millisecond)

	mu.Lock()
	countAfter := requestCount
	mu.Unlock()

	if countAfter != count {
		t.Errorf("expected no more requests after stop, got %d before and %d after", count, countAfter)
	}
}

func TestSendAcpHeartbeats_SkipsWhenNoToken(t *testing.T) {
	requestCount := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer ts.Close()

	s := &Server{
		config: &config.Config{
			NodeID:          "node-test",
			ControlPlaneURL: ts.URL,
		},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-1": {ID: "ws-1", ProjectID: "proj-a", Status: "running"},
		},
		callbackToken: "", // empty token
		httpClient:    &http.Client{Timeout: 5 * time.Second},
		done:          make(chan struct{}),
	}

	s.sendAcpHeartbeats()

	if requestCount != 0 {
		t.Errorf("expected 0 requests when token is empty, got %d", requestCount)
	}
}
