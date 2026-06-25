package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/deploy"
	"github.com/workspace/vm-agent/internal/errorreport"
	"github.com/workspace/vm-agent/internal/persistence"
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
		workspaces: map[string]*WorkspaceRuntime{
			"ws-token-scoped": {ID: "ws-token-scoped", CallbackToken: "workspace-token"},
		},
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
	if got := s.workspaces["ws-token-scoped"].CallbackToken; got != "workspace-token" {
		t.Fatalf("expected workspace token to remain scoped, got %q", got)
	}

	s.sendNodeHeartbeat()

	if got := s.getCallbackToken(); got != refreshedToken {
		t.Fatalf("expected token to remain %q, got %q", refreshedToken, got)
	}

	if heartbeatCount != 2 {
		t.Fatalf("expected 2 heartbeats, got %d", heartbeatCount)
	}
}

func TestRunDetachedDeploymentApplyCancelsAfterIdleProgress(t *testing.T) {
	releaseRequested := make(chan struct{})
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/deploy-release") {
			close(releaseRequested)
			<-r.Context().Done()
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer ts.Close()

	store, err := persistence.Open(filepath.Join(t.TempDir(), "vm-agent.db"))
	if err != nil {
		t.Fatalf("Open persistence store: %v", err)
	}
	defer store.Close()

	s := &Server{
		config: &config.Config{
			NodeID:                 "node-1",
			ControlPlaneURL:        ts.URL,
			CallbackToken:          "callback-token",
			DeployApplyIdleTimeout: 40 * time.Millisecond,
		},
		store:          store,
		applyWatchdogs: make(map[string]chan struct{}),
	}
	disk, err := deploy.NewDiskState(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}
	engine := deploy.NewEngine(disk, nil, deploy.EngineConfig{
		EnvironmentID:   "env-1",
		NodeID:          "node-1",
		ControlPlaneURL: ts.URL,
		CallbackToken:   "callback-token",
		HTTPClient:      deploy.NewArtifactHTTPClient(deploy.ArtifactHTTPClientConfig{}),
		ApplyProgress:   s.persistApplyProgress,
	})

	done := make(chan struct{})
	go func() {
		s.runDetachedDeploymentApply("env-1", 7, engine)
		close(done)
	}()

	select {
	case <-releaseRequested:
	case <-time.After(time.Second):
		t.Fatal("deploy-release endpoint was not requested")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("apply watchdog did not cancel stalled apply")
	}

	job, err := store.GetJob(applyJobID("env-1", 7))
	if err != nil {
		t.Fatalf("GetJob: %v", err)
	}
	if job == nil || job.Status != vmJobStatusFailed || !strings.Contains(job.ErrorMessage, "no progress") {
		t.Fatalf("expected durable stalled apply failure, got %+v", job)
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

type deploymentHeartbeatHarness struct {
	server     *Server
	sitesDir   string
	composeLog string
}

func newDeploymentHeartbeatHarness(t *testing.T, configureResponse func(*heartbeatResponse)) *deploymentHeartbeatHarness {
	t.Helper()

	dir := t.TempDir()
	activeDir := filepath.Join(dir, "active")
	sitesDir := filepath.Join(activeDir, "sites")
	if err := os.MkdirAll(sitesDir, 0755); err != nil {
		t.Fatalf("mkdir sites: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sitesDir, "env-a.caddy"), []byte("env-a"), 0644); err != nil {
		t.Fatalf("write env-a snippet: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sitesDir, "env-b.caddy"), []byte("env-b"), 0644); err != nil {
		t.Fatalf("write env-b snippet: %v", err)
	}

	disk, err := deploy.NewDiskState(filepath.Join(dir, "deploy", "env-a"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}
	state := &deploy.ReleaseState{Seq: 1, EnvironmentID: "env-a", NodeID: "node-deploy", Status: deploy.StatusApplied}
	if err := disk.WriteRelease(state, "services: {}\n", "env-a.apps.example.com {\n\treverse_proxy 127.0.0.1:35000\n}\n"); err != nil {
		t.Fatalf("WriteRelease: %v", err)
	}
	if err := disk.SetCurrent(1); err != nil {
		t.Fatalf("SetCurrent: %v", err)
	}

	composeLog := filepath.Join(dir, "compose.log")
	composeScript := filepath.Join(dir, "compose.sh")
	if err := os.WriteFile(composeScript, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$COMPOSE_LOG\"\n"), 0755); err != nil {
		t.Fatalf("write compose script: %v", err)
	}
	reloadLog := filepath.Join(dir, "reload.log")
	reloadScript := filepath.Join(dir, "reload.sh")
	if err := os.WriteFile(reloadScript, []byte("#!/bin/sh\necho reloaded > \"$1\"\n"), 0755); err != nil {
		t.Fatalf("write reload script: %v", err)
	}
	t.Setenv("COMPOSE_LOG", composeLog)

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := heartbeatResponse{
			Status:          "running",
			LastHeartbeatAt: time.Now().UTC().Format(time.RFC3339),
			HealthStatus:    "healthy",
		}
		configureResponse(&resp)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(ts.Close)

	cfg := &config.Config{
		ControlPlaneURL:   ts.URL,
		NodeID:            "node-deploy",
		CallbackToken:     "token",
		Role:              config.RoleDeployment,
		DeployBaseDir:     filepath.Join(dir, "deploy"),
		DeployComposeCmd:  composeScript,
		HeartbeatInterval: time.Minute,
	}

	s := &Server{
		config:        cfg,
		callbackToken: cfg.CallbackToken,
		workspaces:    make(map[string]*WorkspaceRuntime),
		errorReporter: newTestErrorReporter(),
		done:          make(chan struct{}),
		deployEngines: make(map[string]*deploy.Engine),
	}
	s.SetDeployEngine(deploy.NewEngine(disk, nil, deploy.EngineConfig{
		EnvironmentID:      "env-a",
		NodeID:             cfg.NodeID,
		ControlPlaneURL:    cfg.ControlPlaneURL,
		CallbackToken:      cfg.CallbackToken,
		ComposeCmd:         composeScript,
		ComposeProjectName: "sam-env-env-a",
		CaddyfilePath:      filepath.Join(activeDir, "Caddyfile"),
		CaddyReloadCmd:     reloadScript + " " + reloadLog,
	}))

	return &deploymentHeartbeatHarness{
		server:     s,
		sitesDir:   sitesDir,
		composeLog: composeLog,
	}
}

func TestDeploymentHeartbeatMissingEnvironmentListDoesNotRetireExistingEnvironment(t *testing.T) {
	h := newDeploymentHeartbeatHarness(t, func(resp *heartbeatResponse) {
		resp.DeployPubKey = ""
	})

	h.server.sendNodeHeartbeat()

	assertDeploymentSnippetExists(t, h.sitesDir, "env-a")
	assertDeploymentSnippetExists(t, h.sitesDir, "env-b")
	assertDeployEngineExists(t, h.server, "env-a")
	assertDeployEngineMissing(t, h.server, "env-b")
	assertNoComposeDown(t, h.composeLog)
}

func TestDeploymentHeartbeatDiscoversActiveEnvironmentWithoutRetiringOmittedEngine(t *testing.T) {
	h := newDeploymentHeartbeatHarness(t, func(resp *heartbeatResponse) {
		environments := []deploymentEnvironmentResponse{{EnvironmentID: "env-b"}}
		resp.Deployment.Environments = &environments
	})

	h.server.sendNodeHeartbeat()

	assertDeploymentSnippetExists(t, h.sitesDir, "env-a")
	assertDeploymentSnippetExists(t, h.sitesDir, "env-b")
	assertDeployEngineExists(t, h.server, "env-a")
	assertDeployEngineExists(t, h.server, "env-b")
	assertNoComposeDown(t, h.composeLog)
}

func TestDeploymentHeartbeatExplicitRetireEnvironment(t *testing.T) {
	h := newDeploymentHeartbeatHarness(t, func(resp *heartbeatResponse) {
		resp.Deployment.RetireEnvironments = []deploymentEnvironmentResponse{{EnvironmentID: "env-a"}}
	})

	h.server.sendNodeHeartbeat()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filepath.Join(h.sitesDir, "env-a.caddy")); os.IsNotExist(err) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := os.Stat(filepath.Join(h.sitesDir, "env-a.caddy")); !os.IsNotExist(err) {
		t.Fatalf("expected env-a snippet removed after retirement, stat err=%v", err)
	}
	assertDeploymentSnippetExists(t, h.sitesDir, "env-b")
	assertDeployEngineMissing(t, h.server, "env-a")

	composeArgs, err := os.ReadFile(h.composeLog)
	if err != nil {
		t.Fatalf("read compose log: %v", err)
	}
	if !strings.Contains(string(composeArgs), "--project-name\nsam-env-env-a") || !strings.Contains(string(composeArgs), "\ndown\n") {
		t.Fatalf("expected retired env compose down, got:\n%s", composeArgs)
	}
}

func assertDeploymentSnippetExists(t *testing.T, sitesDir, environmentID string) {
	t.Helper()
	if _, err := os.Stat(filepath.Join(sitesDir, environmentID+".caddy")); err != nil {
		t.Fatalf("expected %s snippet preserved: %v", environmentID, err)
	}
}

func assertDeployEngineExists(t *testing.T, s *Server, environmentID string) {
	t.Helper()
	if _, ok := s.deploymentEnginesSnapshot()[environmentID]; !ok {
		t.Fatalf("expected %s engine present on server", environmentID)
	}
}

func assertDeployEngineMissing(t *testing.T, s *Server, environmentID string) {
	t.Helper()
	if _, ok := s.deploymentEnginesSnapshot()[environmentID]; ok {
		t.Fatalf("expected %s engine absent from server", environmentID)
	}
}

func assertNoComposeDown(t *testing.T, composeLog string) {
	t.Helper()
	composeArgs, err := os.ReadFile(composeLog)
	if os.IsNotExist(err) {
		return
	}
	if err != nil {
		t.Fatalf("read compose log: %v", err)
	}
	if strings.Contains(string(composeArgs), "\ndown\n") {
		t.Fatalf("expected no compose down call, got:\n%s", composeArgs)
	}
}

// ---------------------------------------------------------------------------
// Heartbeat-triggered workspace-ready callback retry tests
// ---------------------------------------------------------------------------

func TestHeartbeatRetriesPendingReadyCallback(t *testing.T) {
	var mu sync.Mutex
	readyCalled := false
	heartbeatCount := 0

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/heartbeat") {
			mu.Lock()
			heartbeatCount++
			mu.Unlock()
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
			mu.Lock()
			readyCalled = true
			mu.Unlock()
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

	mu.Lock()
	hbCount := heartbeatCount
	mu.Unlock()
	if hbCount != 1 {
		t.Fatalf("expected 1 heartbeat, got %d", hbCount)
	}

	// Wait for background retry goroutine to complete
	time.Sleep(100 * time.Millisecond)

	mu.Lock()
	called := readyCalled
	mu.Unlock()
	if !called {
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

func TestHeartbeatRetryTransientErrorKeepsPending(t *testing.T) {
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
			// 503 = transient error — should keep pending for next heartbeat retry
			http.Error(w, "service unavailable", http.StatusServiceUnavailable)
			return
		}
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer ts.Close()

	cfg := &config.Config{
		ControlPlaneURL:               ts.URL,
		NodeID:                        "test-node-transient",
		CallbackToken:                 "node-token",
		HeartbeatInterval:             time.Minute,
		WorkspaceReadyCallbackTimeout: 10 * time.Second,
	}

	s := &Server{
		config:        cfg,
		callbackToken: cfg.CallbackToken,
		workspaces: map[string]*WorkspaceRuntime{
			"ws-transient": {
				ID:                   "ws-transient",
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

	// On transient error (5xx), pending flag should remain set for next retry
	s.workspaceMu.RLock()
	pending := s.workspaces["ws-transient"].ReadyCallbackPending
	s.workspaceMu.RUnlock()
	if !pending {
		t.Fatal("expected ReadyCallbackPending to remain true on transient 5xx error")
	}
}

func TestHeartbeatRetryUsesNodeTokenWhenWorkspaceHasNone(t *testing.T) {
	var mu sync.Mutex
	var receivedAuth string

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
			mu.Lock()
			receivedAuth = r.Header.Get("Authorization")
			mu.Unlock()
			w.WriteHeader(http.StatusOK)
			return
		}
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer ts.Close()

	cfg := &config.Config{
		ControlPlaneURL:               ts.URL,
		NodeID:                        "test-node-fallback",
		CallbackToken:                 "node-level-token",
		HeartbeatInterval:             time.Minute,
		WorkspaceReadyCallbackTimeout: 10 * time.Second,
	}

	s := &Server{
		config:        cfg,
		callbackToken: cfg.CallbackToken,
		workspaces: map[string]*WorkspaceRuntime{
			"ws-no-token": {
				ID:                   "ws-no-token",
				Status:               "running",
				CallbackToken:        "", // empty — should fall back to node token
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

	mu.Lock()
	auth := receivedAuth
	mu.Unlock()
	if auth != "Bearer node-level-token" {
		t.Fatalf("expected retry to use node-level token, got %q", auth)
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
