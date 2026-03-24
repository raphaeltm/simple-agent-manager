package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/errorreport"
)

// newTestErrorReporter creates a minimal error reporter for tests.
func newTestErrorReporter() *errorreport.Reporter {
	return errorreport.New("http://localhost", "test", "test", errorreport.Config{})
}

func TestCallbackTokenRefresh(t *testing.T) {
	heartbeatCount := 0
	refreshedToken := "new-refreshed-token-abc123"

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		heartbeatCount++

		auth := r.Header.Get("Authorization")
		if auth == "" {
			t.Error("Missing Authorization header")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		resp := heartbeatResponse{
			Status:          "running",
			LastHeartbeatAt: time.Now().UTC().Format(time.RFC3339),
			HealthStatus:    "healthy",
		}

		if heartbeatCount == 1 {
			resp.RefreshedToken = refreshedToken
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer ts.Close()

	cfg := &config.Config{
		ControlPlaneURL:   ts.URL,
		NodeID:            "test-node-001",
		CallbackToken:     "original-token",
		HeartbeatInterval: time.Minute,
	}

	s := &Server{
		config:        cfg,
		callbackToken: cfg.CallbackToken,
		workspaces:    make(map[string]*WorkspaceRuntime),
		errorReporter: newTestErrorReporter(),
		done:          make(chan struct{}),
	}

	if got := s.getCallbackToken(); got != "original-token" {
		t.Fatalf("expected initial token 'original-token', got %q", got)
	}

	s.sendNodeHeartbeat()

	if got := s.getCallbackToken(); got != refreshedToken {
		t.Fatalf("expected refreshed token %q, got %q", refreshedToken, got)
	}

	s.sendNodeHeartbeat()

	if got := s.getCallbackToken(); got != refreshedToken {
		t.Fatalf("expected token to remain %q, got %q", refreshedToken, got)
	}

	if heartbeatCount != 2 {
		t.Fatalf("expected 2 heartbeats, got %d", heartbeatCount)
	}
}

func TestCallbackTokenRefreshUsesNewTokenForSubsequentRequests(t *testing.T) {
	receivedTokens := make([]string, 0)
	var mu sync.Mutex

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		mu.Lock()
		receivedTokens = append(receivedTokens, auth)
		count := len(receivedTokens)
		mu.Unlock()

		resp := heartbeatResponse{
			Status:          "running",
			LastHeartbeatAt: time.Now().UTC().Format(time.RFC3339),
			HealthStatus:    "healthy",
		}

		if count == 1 {
			resp.RefreshedToken = "refreshed-v2"
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer ts.Close()

	cfg := &config.Config{
		ControlPlaneURL:   ts.URL,
		NodeID:            "test-node-002",
		CallbackToken:     "original-v1",
		HeartbeatInterval: time.Minute,
	}

	s := &Server{
		config:        cfg,
		callbackToken: cfg.CallbackToken,
		workspaces:    make(map[string]*WorkspaceRuntime),
		errorReporter: newTestErrorReporter(),
		done:          make(chan struct{}),
	}

	s.sendNodeHeartbeat()
	s.sendNodeHeartbeat()

	mu.Lock()
	defer mu.Unlock()

	if len(receivedTokens) != 2 {
		t.Fatalf("expected 2 heartbeats, got %d", len(receivedTokens))
	}
	if receivedTokens[0] != "Bearer original-v1" {
		t.Errorf("first heartbeat should use original token, got %q", receivedTokens[0])
	}
	if receivedTokens[1] != "Bearer refreshed-v2" {
		t.Errorf("second heartbeat should use refreshed token, got %q", receivedTokens[1])
	}
}

func TestHeartbeatNoRefreshOnServerError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "internal error", http.StatusInternalServerError)
	}))
	defer ts.Close()

	cfg := &config.Config{
		ControlPlaneURL:   ts.URL,
		NodeID:            "test-node-003",
		CallbackToken:     "keep-this-token",
		HeartbeatInterval: time.Minute,
	}

	s := &Server{
		config:        cfg,
		callbackToken: cfg.CallbackToken,
		workspaces:    make(map[string]*WorkspaceRuntime),
		errorReporter: newTestErrorReporter(),
		done:          make(chan struct{}),
	}

	s.sendNodeHeartbeat()

	if got := s.getCallbackToken(); got != "keep-this-token" {
		t.Fatalf("expected token unchanged on error, got %q", got)
	}
}

// ---------------------------------------------------------------------------
// Heartbeat-triggered workspace-ready callback retry tests
// ---------------------------------------------------------------------------

func TestHeartbeatRetriesPendingReadyCallback(t *testing.T) {
	readyCalled := false
	heartbeatCount := 0

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/heartbeat") {
			heartbeatCount++
			resp := heartbeatResponse{
				Status:          "running",
				LastHeartbeatAt: time.Now().UTC().Format(time.RFC3339),
				HealthStatus:    "healthy",
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/ready") {
			readyCalled = true
			if got := r.Header.Get("Authorization"); got != "Bearer ws-token-123" {
				t.Errorf("unexpected auth header on ready retry: %s", got)
			}
			var payload map[string]string
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("failed to decode ready payload: %v", err)
			}
			if payload["status"] != "running" {
				t.Errorf("expected status 'running', got %q", payload["status"])
			}
			w.WriteHeader(http.StatusOK)
			return
		}
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer ts.Close()

	cfg := &config.Config{
		ControlPlaneURL:               ts.URL,
		NodeID:                        "test-node-retry",
		CallbackToken:                 "node-token",
		HeartbeatInterval:             time.Minute,
		WorkspaceReadyCallbackTimeout: 10 * time.Second,
	}

	s := &Server{
		config:        cfg,
		callbackToken: cfg.CallbackToken,
		workspaces: map[string]*WorkspaceRuntime{
			"ws-retry-01": {
				ID:                   "ws-retry-01",
				Status:               "running",
				CallbackToken:        "ws-token-123",
				ReadyCallbackPending: true,
				ReadyCallbackStatus:  "running",
			},
		},
		errorReporter: newTestErrorReporter(),
		done:          make(chan struct{}),
	}

	// Heartbeat should trigger the pending callback retry (runs in background goroutine)
	s.sendNodeHeartbeat()

	if heartbeatCount != 1 {
		t.Fatalf("expected 1 heartbeat, got %d", heartbeatCount)
	}

	// Wait for background retry goroutine to complete
	time.Sleep(100 * time.Millisecond)

	if !readyCalled {
		t.Fatal("expected workspace-ready callback to be retried after heartbeat")
	}

	// Verify pending flag was cleared
	s.workspaceMu.RLock()
	ws := s.workspaces["ws-retry-01"]
	pending := ws.ReadyCallbackPending
	s.workspaceMu.RUnlock()
	if pending {
		t.Fatal("expected ReadyCallbackPending to be cleared after successful retry")
	}
}

func TestHeartbeatRetrySkipsWhenNoPending(t *testing.T) {
	callCount := 0

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		resp := heartbeatResponse{
			Status:          "running",
			LastHeartbeatAt: time.Now().UTC().Format(time.RFC3339),
			HealthStatus:    "healthy",
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer ts.Close()

	cfg := &config.Config{
		ControlPlaneURL:               ts.URL,
		NodeID:                        "test-node-nopending",
		CallbackToken:                 "token",
		HeartbeatInterval:             time.Minute,
		WorkspaceReadyCallbackTimeout: 10 * time.Second,
	}

	s := &Server{
		config:        cfg,
		callbackToken: cfg.CallbackToken,
		workspaces: map[string]*WorkspaceRuntime{
			"ws-ok": {ID: "ws-ok", Status: "running", ReadyCallbackPending: false},
		},
		errorReporter: newTestErrorReporter(),
		done:          make(chan struct{}),
	}

	s.sendNodeHeartbeat()

	// Only the heartbeat request — no workspace-ready retry
	if callCount != 1 {
		t.Fatalf("expected 1 request (heartbeat only), got %d", callCount)
	}
}

func TestHeartbeatRetryPermanentErrorClearsPending(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/heartbeat") {
			resp := heartbeatResponse{
				Status:          "running",
				LastHeartbeatAt: time.Now().UTC().Format(time.RFC3339),
				HealthStatus:    "healthy",
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/ready") {
			// 400 = permanent error (workspace stopped/deleted)
			http.Error(w, "workspace not creating", http.StatusBadRequest)
			return
		}
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer ts.Close()

	cfg := &config.Config{
		ControlPlaneURL:               ts.URL,
		NodeID:                        "test-node-perm",
		CallbackToken:                 "node-token",
		HeartbeatInterval:             time.Minute,
		WorkspaceReadyCallbackTimeout: 10 * time.Second,
	}

	s := &Server{
		config:        cfg,
		callbackToken: cfg.CallbackToken,
		workspaces: map[string]*WorkspaceRuntime{
			"ws-perm-fail": {
				ID:                   "ws-perm-fail",
				Status:               "running",
				CallbackToken:        "ws-token",
				ReadyCallbackPending: true,
				ReadyCallbackStatus:  "running",
			},
		},
		errorReporter: newTestErrorReporter(),
		done:          make(chan struct{}),
	}

	s.sendNodeHeartbeat()

	// Wait for background retry goroutine to complete
	time.Sleep(100 * time.Millisecond)

	// Even on permanent error, pending should be cleared (stop retrying)
	s.workspaceMu.RLock()
	pending := s.workspaces["ws-perm-fail"].ReadyCallbackPending
	s.workspaceMu.RUnlock()
	if pending {
		t.Fatal("expected ReadyCallbackPending to be cleared on permanent error")
	}
}

func TestHeartbeatNoRefreshWhenFieldEmpty(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := heartbeatResponse{
			Status:          "running",
			LastHeartbeatAt: time.Now().UTC().Format(time.RFC3339),
			HealthStatus:    "healthy",
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer ts.Close()

	cfg := &config.Config{
		ControlPlaneURL:   ts.URL,
		NodeID:            "test-node-004",
		CallbackToken:     "stable-token",
		HeartbeatInterval: time.Minute,
	}

	s := &Server{
		config:        cfg,
		callbackToken: cfg.CallbackToken,
		workspaces:    make(map[string]*WorkspaceRuntime),
		errorReporter: newTestErrorReporter(),
		done:          make(chan struct{}),
	}

	s.sendNodeHeartbeat()

	if got := s.getCallbackToken(); got != "stable-token" {
		t.Fatalf("expected token unchanged when no refresh, got %q", got)
	}
}
