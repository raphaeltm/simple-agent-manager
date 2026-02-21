//go:build e2e

// Package e2e contains end-to-end tests that exercise the full vm-agent lifecycle
// including server startup, bootstrap, and WebSocket communication. These tests
// require Docker and the devcontainer CLI.
package e2e

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/server"
)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

func requireDockerAvailable(t *testing.T) {
	t.Helper()
	if out, err := exec.Command("docker", "info").CombinedOutput(); err != nil {
		t.Skipf("Docker not available: %v\n%s", err, string(out))
	}
}

func requireDevcontainerCLI(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("devcontainer"); err != nil {
		t.Skipf("devcontainer CLI not installed; install with: npm install -g @devcontainers/cli")
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("freePort: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port
}

func testKeyPair(t *testing.T) (ed25519.PrivateKey, string, string) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate ed25519 key: %v", err)
	}
	pubB64 := base64.RawURLEncoding.EncodeToString(pub)
	return priv, pubB64, "test-key-1"
}

func signTestJWT(t *testing.T, privateKey ed25519.PrivateKey, keyID, issuer, audience, workspaceID, nodeID string) string {
	t.Helper()
	now := time.Now()
	claims := jwt.MapClaims{
		"iss":       issuer,
		"aud":       audience,
		"sub":       "test-user-id",
		"workspace": workspaceID,
		"node":      nodeID,
		"iat":       now.Unix(),
		"exp":       now.Add(1 * time.Hour).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	token.Header["kid"] = keyID
	signed, err := token.SignedString(privateKey)
	if err != nil {
		t.Fatalf("sign JWT: %v", err)
	}
	return signed
}

// buildTestConfig creates a config.Config with all required fields populated.
// This avoids zero-value panics from subsystems like SessionManager that need
// positive durations for tickers.
func buildTestConfig(t *testing.T, port int, mockServerURL, workspaceID, bootstrapToken, repo string) *config.Config {
	t.Helper()
	return &config.Config{
		Port:                          port,
		Host:                          "127.0.0.1",
		ControlPlaneURL:               mockServerURL,
		JWKSEndpoint:                  mockServerURL + "/.well-known/jwks.json",
		JWTIssuer:                     mockServerURL,
		JWTAudience:                   "workspace-terminal",
		NodeID:                        workspaceID,
		WorkspaceID:                   workspaceID,
		BootstrapToken:                bootstrapToken,
		Repository:                    repo,
		Branch:                        "main",
		WorkspaceDir:                  repo,
		BootstrapStatePath:            filepath.Join(t.TempDir(), "bootstrap-state.json"),
		BootstrapMaxWait:              30 * time.Second,
		BootstrapTimeout:              5 * time.Minute,
		ContainerMode:                 true,
		ContainerLabelKey:             "devcontainer.local_folder",
		ContainerLabelValue:           repo,
		AdditionalFeatures:            config.DefaultAdditionalFeatures,
		DefaultDevcontainerConfigPath: filepath.Join(t.TempDir(), "default-devcontainer.json"),
		PersistenceDBPath:             filepath.Join(t.TempDir(), "state.db"),

		// Session management
		SessionTTL:             24 * time.Hour,
		SessionCleanupInterval: 1 * time.Minute,
		SessionMaxCount:        100,
		CookieName:             "sam_session",

		// Idle detection
		IdleTimeout:       30 * time.Minute,
		HeartbeatInterval: 60 * time.Second,
		IdleCheckInterval: 10 * time.Second,

		// HTTP
		HTTPReadTimeout: 30 * time.Second,
		HTTPIdleTimeout: 120 * time.Second,

		// WebSocket
		WSReadBufferSize:  4096,
		WSWriteBufferSize: 4096,
		AllowedOrigins:    []string{"*"},

		// PTY
		DefaultShell:    "/bin/sh",
		DefaultRows:     24,
		DefaultCols:     80,
		PTYOutputBufferSize: 262144,

		// ACP
		ACPInitTimeoutMs:      30000,
		ACPMaxRestartAttempts: 3,
		ACPPingInterval:       30 * time.Second,
		ACPPongTimeout:        10 * time.Second,
		ACPPromptTimeout:      60 * time.Minute,

		// Error reporting
		ErrorReportFlushInterval: 30 * time.Second,
		ErrorReportMaxBatchSize:  10,
		ErrorReportMaxQueueSize:  100,
		ErrorReportHTTPTimeout:   10 * time.Second,

		// Container
		ContainerCacheTTL: 30 * time.Second,

		// Git
		GitExecTimeout: 30 * time.Second,
		GitFileMaxSize: 1048576,

		// System info
		SysInfoDockerTimeout:  10 * time.Second,
		SysInfoVersionTimeout: 5 * time.Second,
		SysInfoCacheTTL:       5 * time.Second,
	}
}

// controlPlaneState tracks what the mock control plane received.
type controlPlaneState struct {
	mu                sync.Mutex
	bootstrapRedeemed bool
	readyCalled       bool
	readyStatus       string
	lastReadyAuth     string
	bootLogs          []map[string]interface{}
	heartbeats        int
}

func startMockControlPlane(
	t *testing.T,
	workspaceID, bootstrapToken, callbackToken string,
	privateKey ed25519.PrivateKey, pubKeyB64, keyID string,
) (*httptest.Server, *controlPlaneState) {
	t.Helper()
	state := &controlPlaneState{}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Bootstrap token redemption
		if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/bootstrap/") {
			token := strings.TrimPrefix(r.URL.Path, "/api/bootstrap/")
			if token != bootstrapToken {
				http.Error(w, "invalid token", http.StatusUnauthorized)
				return
			}
			state.mu.Lock()
			state.bootstrapRedeemed = true
			state.mu.Unlock()

			json.NewEncoder(w).Encode(map[string]interface{}{
				"workspaceId":   workspaceID,
				"callbackToken": callbackToken,
			})
			return
		}

		// Boot log append
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/boot-log") {
			var entry map[string]interface{}
			if err := json.NewDecoder(r.Body).Decode(&entry); err != nil {
				http.Error(w, "bad json", http.StatusBadRequest)
				return
			}
			state.mu.Lock()
			state.bootLogs = append(state.bootLogs, entry)
			state.mu.Unlock()
			w.WriteHeader(http.StatusOK)
			return
		}

		// Workspace ready
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/ready") {
			state.mu.Lock()
			state.readyCalled = true
			state.lastReadyAuth = r.Header.Get("Authorization")
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err == nil {
				state.readyStatus = body["status"]
			}
			state.mu.Unlock()
			w.WriteHeader(http.StatusOK)
			return
		}

		// JWKS endpoint
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/.well-known/jwks.json") {
			jwks := map[string]interface{}{
				"keys": []map[string]interface{}{
					{
						"kty": "OKP",
						"crv": "Ed25519",
						"x":   pubKeyB64,
						"kid": keyID,
						"use": "sig",
						"alg": "EdDSA",
					},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(jwks)
			return
		}

		// Heartbeat
		if r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/heartbeat") {
			state.mu.Lock()
			state.heartbeats++
			state.mu.Unlock()
			w.WriteHeader(http.StatusOK)
			return
		}

		// Error reports / node health — accept silently
		if r.Method == http.MethodPost {
			w.WriteHeader(http.StatusOK)
			return
		}

		log.Printf("mock control plane: unhandled %s %s", r.Method, r.URL.Path)
		http.Error(w, "not found", http.StatusNotFound)
	}))

	t.Cleanup(srv.Close)
	return srv, state
}

func mustCreateTestRepo(t *testing.T, devcontainerJSON string) string {
	t.Helper()
	dir := t.TempDir()

	cmds := [][]string{
		{"git", "init", dir},
		{"git", "-C", dir, "config", "user.email", "test@e2e.local"},
		{"git", "-C", dir, "config", "user.name", "E2E Test"},
	}
	for _, args := range cmds {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("%v failed: %v\n%s", args, err, out)
		}
	}

	os.WriteFile(filepath.Join(dir, "README.md"), []byte("# E2E Test Repo\n"), 0o644)

	if devcontainerJSON != "" {
		dcDir := filepath.Join(dir, ".devcontainer")
		os.MkdirAll(dcDir, 0o755)
		os.WriteFile(filepath.Join(dcDir, "devcontainer.json"), []byte(devcontainerJSON), 0o644)
	}

	addCommit := [][]string{
		{"git", "-C", dir, "add", "."},
		{"git", "-C", dir, "commit", "-m", "initial commit"},
	}
	for _, args := range addCommit {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("%v failed: %v\n%s", args, err, out)
		}
	}
	return dir
}

func waitForHealth(ctx context.Context, baseURL string) error {
	client := &http.Client{Timeout: 2 * time.Second}
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("health check timed out: %w", ctx.Err())
		case <-ticker.C:
			resp, err := client.Get(baseURL + "/health")
			if err == nil {
				resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					return nil
				}
			}
		}
	}
}

// cleanupDockerResources removes containers matching the label and the workspace volume.
func cleanupDockerResources(t *testing.T, cfg *config.Config, workspaceID string) {
	t.Helper()
	ctx := context.Background()
	filter := fmt.Sprintf("label=%s=%s", cfg.ContainerLabelKey, cfg.ContainerLabelValue)
	if out, err := exec.CommandContext(ctx, "docker", "ps", "-aq", "--filter", filter).Output(); err == nil {
		for _, id := range strings.Fields(string(out)) {
			exec.Command("docker", "rm", "-f", id).Run()
		}
	}
	bootstrap.RemoveVolume(ctx, workspaceID)
}

// BootLogWSEntry matches the JSON structure sent over the boot log WebSocket.
type BootLogWSEntry struct {
	Type      string `json:"type"`
	Step      string `json:"step"`
	Status    string `json:"status"`
	Message   string `json:"message"`
	Detail    string `json:"detail,omitempty"`
	Timestamp string `json:"timestamp"`
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestBootLogStreaming_HealthBeforeBootstrap verifies that the vm-agent HTTP
// server is reachable (health endpoint responds) BEFORE bootstrap completes.
func TestBootLogStreaming_HealthBeforeBootstrap(t *testing.T) {
	requireDockerAvailable(t)
	requireDevcontainerCLI(t)

	workspaceID := "E2EHLTH"
	bootstrapToken := "test-bootstrap-token-health"
	callbackToken := "test-callback-token-health"

	privateKey, pubKeyB64, keyID := testKeyPair(t)
	repo := mustCreateTestRepo(t, `{"image": "mcr.microsoft.com/devcontainers/base:debian"}`)
	mockCP, cpState := startMockControlPlane(t, workspaceID, bootstrapToken, callbackToken, privateKey, pubKeyB64, keyID)

	port := freePort(t)
	cfg := buildTestConfig(t, port, mockCP.URL, workspaceID, bootstrapToken, repo)

	reporter := bootlog.New(cfg.ControlPlaneURL, cfg.WorkspaceID)

	srv, err := server.New(cfg)
	if err != nil {
		t.Fatalf("server.New: %v", err)
	}
	srv.SetBootLog(reporter)
	t.Cleanup(func() { cleanupDockerResources(t, cfg, workspaceID) })
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Stop(ctx)
	})

	go srv.Start()

	// ASSERTION 1: Health endpoint responds BEFORE bootstrap starts.
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	healthCtx, healthCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer healthCancel()
	if err := waitForHealth(healthCtx, baseURL); err != nil {
		t.Fatalf("FAIL: Health endpoint not reachable before bootstrap: %v", err)
	}
	t.Log("PASS: Health endpoint responds before bootstrap starts")

	// Now run bootstrap
	bootstrapCtx, bootstrapCancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer bootstrapCancel()
	if err := bootstrap.Run(bootstrapCtx, cfg, reporter); err != nil {
		t.Fatalf("bootstrap.Run: %v", err)
	}

	// ASSERTION 2: Bootstrap token was redeemed
	cpState.mu.Lock()
	redeemed := cpState.bootstrapRedeemed
	cpState.mu.Unlock()
	if !redeemed {
		t.Fatal("FAIL: Bootstrap token was not redeemed")
	}
	t.Log("PASS: Bootstrap token redeemed")

	// ASSERTION 3: Ready callback fired
	cpState.mu.Lock()
	ready := cpState.readyCalled
	cpState.mu.Unlock()
	if !ready {
		t.Fatal("FAIL: Workspace ready callback was not called")
	}
	t.Log("PASS: Ready callback fired")

	// ASSERTION 4: Boot logs were sent via HTTP
	cpState.mu.Lock()
	logCount := len(cpState.bootLogs)
	cpState.mu.Unlock()
	if logCount == 0 {
		t.Fatal("FAIL: No boot logs were sent to control plane via HTTP")
	}
	t.Logf("PASS: %d boot log entries sent via HTTP", logCount)

	// ASSERTION 5: Health still works after bootstrap
	healthCtx2, healthCancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer healthCancel2()
	if err := waitForHealth(healthCtx2, baseURL); err != nil {
		t.Fatalf("FAIL: Health endpoint not reachable after bootstrap: %v", err)
	}
	t.Log("PASS: Health endpoint responds after bootstrap")
}

// TestBootLogStreaming_WebSocketDuringBootstrap verifies that a WebSocket client
// can connect to /boot-log/ws during bootstrap and receive real-time log entries.
func TestBootLogStreaming_WebSocketDuringBootstrap(t *testing.T) {
	requireDockerAvailable(t)
	requireDevcontainerCLI(t)

	workspaceID := "E2EWSBT"
	bootstrapToken := "test-bootstrap-token-ws"
	callbackToken := "test-callback-token-ws"

	privateKey, pubKeyB64, keyID := testKeyPair(t)
	repo := mustCreateTestRepo(t, `{"image": "mcr.microsoft.com/devcontainers/base:debian"}`)
	mockCP, cpState := startMockControlPlane(t, workspaceID, bootstrapToken, callbackToken, privateKey, pubKeyB64, keyID)

	port := freePort(t)
	cfg := buildTestConfig(t, port, mockCP.URL, workspaceID, bootstrapToken, repo)

	reporter := bootlog.New(cfg.ControlPlaneURL, cfg.WorkspaceID)

	srv, err := server.New(cfg)
	if err != nil {
		t.Fatalf("server.New: %v", err)
	}
	srv.SetBootLog(reporter)

	// Wire broadcaster for real-time WebSocket delivery.
	broadcaster := srv.GetBootLogBroadcaster()
	if broadcaster == nil {
		t.Fatal("FAIL: server.GetBootLogBroadcaster() returned nil")
	}
	reporter.SetBroadcaster(broadcaster)

	t.Cleanup(func() { cleanupDockerResources(t, cfg, workspaceID) })
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Stop(ctx)
	})

	go srv.Start()

	baseURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	healthCtx, healthCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer healthCancel()
	if err := waitForHealth(healthCtx, baseURL); err != nil {
		t.Fatalf("Health endpoint not reachable: %v", err)
	}

	// Sign a JWT for WebSocket auth
	wsToken := signTestJWT(t, privateKey, keyID, mockCP.URL, "workspace-terminal", workspaceID, workspaceID)

	// Connect WebSocket to /boot-log/ws BEFORE bootstrap starts
	wsURL := fmt.Sprintf("ws://127.0.0.1:%d/boot-log/ws?token=%s", port, wsToken)
	wsConn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("FAIL: WebSocket connection to /boot-log/ws failed: %v", err)
	}
	t.Cleanup(func() { wsConn.Close() })
	t.Log("PASS: WebSocket connected to /boot-log/ws before bootstrap")

	// Collect WebSocket messages in background
	var wsMessages []BootLogWSEntry
	var wsMu sync.Mutex
	wsDone := make(chan struct{})
	go func() {
		defer close(wsDone)
		for {
			var entry BootLogWSEntry
			if err := wsConn.ReadJSON(&entry); err != nil {
				return
			}
			wsMu.Lock()
			wsMessages = append(wsMessages, entry)
			wsMu.Unlock()
			if entry.Type == "complete" {
				return
			}
		}
	}()

	// Run bootstrap
	bootstrapCtx, bootstrapCancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer bootstrapCancel()
	if err := bootstrap.Run(bootstrapCtx, cfg, reporter); err != nil {
		t.Fatalf("bootstrap.Run: %v", err)
	}

	// Signal bootstrap complete to WebSocket clients
	srv.UpdateAfterBootstrap(cfg)

	// Wait for "complete" message
	select {
	case <-wsDone:
		t.Log("PASS: WebSocket received complete event")
	case <-time.After(10 * time.Second):
		t.Fatal("FAIL: Timed out waiting for WebSocket complete event")
	}

	wsMu.Lock()
	wsEntries := make([]BootLogWSEntry, len(wsMessages))
	copy(wsEntries, wsMessages)
	wsMu.Unlock()

	if len(wsEntries) == 0 {
		t.Fatal("FAIL: No WebSocket messages received during bootstrap")
	}
	t.Logf("PASS: %d WebSocket messages received during bootstrap", len(wsEntries))

	// Check expected steps
	stepsSeen := map[string]bool{}
	for _, entry := range wsEntries {
		if entry.Step != "" {
			stepsSeen[entry.Step] = true
		}
	}
	for _, step := range []string{"bootstrap_redeem", "devcontainer_up", "workspace_ready"} {
		if !stepsSeen[step] {
			t.Errorf("FAIL: Expected step %q not found in WebSocket messages", step)
		}
	}
	t.Log("PASS: All expected bootstrap steps received via WebSocket")

	// Last message should be "complete"
	if last := wsEntries[len(wsEntries)-1]; last.Type != "complete" {
		t.Errorf("FAIL: Last WebSocket message type is %q, expected 'complete'", last.Type)
	}

	// HTTP boot logs were also sent (KV relay still works)
	cpState.mu.Lock()
	httpLogCount := len(cpState.bootLogs)
	readyCalled := cpState.readyCalled
	cpState.mu.Unlock()
	if httpLogCount == 0 {
		t.Fatal("FAIL: No boot logs sent via HTTP (KV relay broken)")
	}
	t.Logf("PASS: %d boot log entries also sent via HTTP (KV relay works)", httpLogCount)
	if !readyCalled {
		t.Fatal("FAIL: Ready callback not called")
	}
}

// TestBootLogStreaming_LateJoinCatchUp verifies that a WebSocket client that
// connects AFTER bootstrap completes receives the buffered history.
func TestBootLogStreaming_LateJoinCatchUp(t *testing.T) {
	requireDockerAvailable(t)
	requireDevcontainerCLI(t)

	workspaceID := "E2ELATE"
	bootstrapToken := "test-bootstrap-token-late"
	callbackToken := "test-callback-token-late"

	privateKey, pubKeyB64, keyID := testKeyPair(t)
	repo := mustCreateTestRepo(t, `{"image": "mcr.microsoft.com/devcontainers/base:debian"}`)
	mockCP, _ := startMockControlPlane(t, workspaceID, bootstrapToken, callbackToken, privateKey, pubKeyB64, keyID)

	port := freePort(t)
	cfg := buildTestConfig(t, port, mockCP.URL, workspaceID, bootstrapToken, repo)

	reporter := bootlog.New(cfg.ControlPlaneURL, cfg.WorkspaceID)

	srv, err := server.New(cfg)
	if err != nil {
		t.Fatalf("server.New: %v", err)
	}
	srv.SetBootLog(reporter)

	broadcaster := srv.GetBootLogBroadcaster()
	if broadcaster == nil {
		t.Fatal("FAIL: server.GetBootLogBroadcaster() returned nil")
	}
	reporter.SetBroadcaster(broadcaster)

	t.Cleanup(func() { cleanupDockerResources(t, cfg, workspaceID) })
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Stop(ctx)
	})

	go srv.Start()

	baseURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	healthCtx, healthCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer healthCancel()
	if err := waitForHealth(healthCtx, baseURL); err != nil {
		t.Fatalf("Health not reachable: %v", err)
	}

	// Run bootstrap to completion FIRST (no WS client connected yet)
	bootstrapCtx, bootstrapCancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer bootstrapCancel()
	if err := bootstrap.Run(bootstrapCtx, cfg, reporter); err != nil {
		t.Fatalf("bootstrap.Run: %v", err)
	}
	srv.UpdateAfterBootstrap(cfg)

	// NOW connect a late-joining WebSocket client
	wsToken := signTestJWT(t, privateKey, keyID, mockCP.URL, "workspace-terminal", workspaceID, workspaceID)
	wsURL := fmt.Sprintf("ws://127.0.0.1:%d/boot-log/ws?token=%s", port, wsToken)
	wsConn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("FAIL: Late-join WebSocket connection failed: %v", err)
	}
	defer wsConn.Close()

	// Read all buffered messages (should get history + complete)
	var lateMessages []BootLogWSEntry
	wsConn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		var entry BootLogWSEntry
		if err := wsConn.ReadJSON(&entry); err != nil {
			break
		}
		lateMessages = append(lateMessages, entry)
		if entry.Type == "complete" {
			break
		}
	}

	if len(lateMessages) == 0 {
		t.Fatal("FAIL: Late-joining client received no buffered messages")
	}
	t.Logf("PASS: Late-joining client received %d buffered messages", len(lateMessages))

	stepsSeen := map[string]bool{}
	for _, entry := range lateMessages {
		if entry.Step != "" {
			stepsSeen[entry.Step] = true
		}
	}
	if !stepsSeen["bootstrap_redeem"] {
		t.Error("FAIL: Late-join buffer missing bootstrap_redeem step")
	}

	if last := lateMessages[len(lateMessages)-1]; last.Type != "complete" {
		t.Errorf("FAIL: Last late-join message type is %q, expected 'complete'", last.Type)
	}
	t.Log("PASS: Late-join catch-up works correctly")
}
