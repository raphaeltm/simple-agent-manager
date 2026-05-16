package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/pty"
)

func TestWorkspaceManagementSourceContract(t *testing.T) {
	path := filepath.Join("workspaces.go")
	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	content := string(contentBytes)

	for _, needle := range []string{
		"handleCreateWorkspace",
		"handleStopWorkspace",
		"handleRestartWorkspace",
		"handleDeleteWorkspace",
		"stopSessionHost",
		"stopSessionHostsForWorkspace",
		"callbackToken",
		"provisionWorkspaceRuntime",
		"recovery",
	} {
		if !strings.Contains(content, needle) {
			t.Fatalf("expected %q in %s", needle, path)
		}
	}
}

func TestCreateWorkspaceDuplicateProvisioningReturnsIdempotentAccepted(t *testing.T) {
	originalPrepare := prepareWorkspaceForRuntime
	defer func() { prepareWorkspaceForRuntime = originalPrepare }()

	started := make(chan struct{}, 2)
	release := make(chan struct{})
	var prepareCalls int32
	prepareWorkspaceForRuntime = func(_ context.Context, _ *config.Config, _ bootstrap.ProvisionState, _ *bootlog.Reporter) (bool, error) {
		atomic.AddInt32(&prepareCalls, 1)
		started <- struct{}{}
		<-release
		return false, nil
	}

	controlPlane := newWorkspaceCreateControlPlane(t)
	validator, privateKey := newWorkspaceCreateJWTValidator(t, "node-1")
	s := newWorkspaceCreateServer(t, controlPlane.URL, validator)
	token := signWorkspaceCreateNodeToken(t, privateKey, "node-1", "ws-race")

	var wg sync.WaitGroup
	responses := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := postCreateWorkspace(t, s, token, "ws-race")
			responses <- rec.Code
		}()
	}
	wg.Wait()
	close(responses)

	for code := range responses {
		if code != http.StatusAccepted {
			t.Fatalf("expected duplicate create response status 202, got %d", code)
		}
	}

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for provisioning to start")
	}
	if got := atomic.LoadInt32(&prepareCalls); got != 1 {
		t.Fatalf("expected one provisioning call, got %d", got)
	}

	close(release)
	waitForProvisioningInactive(t, s, "ws-race")
}

func TestCreateWorkspaceCanProvisionAgainAfterCompletion(t *testing.T) {
	originalPrepare := prepareWorkspaceForRuntime
	defer func() { prepareWorkspaceForRuntime = originalPrepare }()

	var prepareCalls int32
	prepareWorkspaceForRuntime = func(_ context.Context, _ *config.Config, _ bootstrap.ProvisionState, _ *bootlog.Reporter) (bool, error) {
		atomic.AddInt32(&prepareCalls, 1)
		return false, nil
	}

	controlPlane := newWorkspaceCreateControlPlane(t)
	validator, privateKey := newWorkspaceCreateJWTValidator(t, "node-1")
	s := newWorkspaceCreateServer(t, controlPlane.URL, validator)
	token := signWorkspaceCreateNodeToken(t, privateKey, "node-1", "ws-repeat")

	first := postCreateWorkspace(t, s, token, "ws-repeat")
	if first.Code != http.StatusAccepted {
		t.Fatalf("expected first create status 202, got %d", first.Code)
	}
	waitForProvisioningCalls(t, &prepareCalls, 1)
	waitForProvisioningInactive(t, s, "ws-repeat")

	second := postCreateWorkspace(t, s, token, "ws-repeat")
	if second.Code != http.StatusAccepted {
		t.Fatalf("expected second create status 202, got %d", second.Code)
	}
	waitForProvisioningCalls(t, &prepareCalls, 2)
	waitForProvisioningInactive(t, s, "ws-repeat")
}

func newWorkspaceCreateControlPlane(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/git-token"):
			_, _ = w.Write([]byte(`{"token":"git-token"}`))
		case strings.HasSuffix(r.URL.Path, "/runtime-assets"):
			_, _ = w.Write([]byte(`{"envVars":[],"files":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func newWorkspaceCreateServer(t *testing.T, controlPlaneURL string, validator *auth.JWTValidator) *Server {
	t.Helper()
	return &Server{
		config: &config.Config{
			NodeID:            "node-1",
			WorkspaceDir:      t.TempDir(),
			DefaultShell:      "/bin/sh",
			DefaultRows:       24,
			DefaultCols:       80,
			ContainerLabelKey: "devcontainer.local_folder",
			ControlPlaneURL:   controlPlaneURL,
			CallbackToken:     "callback-token",
		},
		jwtValidator:        validator,
		workspaces:          map[string]*WorkspaceRuntime{},
		nodeEvents:          make([]EventRecord, 0),
		workspaceEvents:     map[string][]EventRecord{},
		agentSessions:       agentsessions.NewManager(),
		sessionHosts:        map[string]*acp.SessionHost{},
		bootLogBroadcasters: NewBootLogBroadcasterManager(),
	}
}

func newWorkspaceCreateJWTValidator(t *testing.T, nodeID string) (*auth.JWTValidator, *rsa.PrivateKey) {
	t.Helper()
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate RSA key: %v", err)
	}

	jwks := buildWorkspaceCreateJWKS(privateKey.Public().(*rsa.PublicKey))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(jwks)
	}))
	t.Cleanup(server.Close)

	validator, err := auth.NewJWTValidator(server.URL, nodeID, "test-issuer", "test-audience")
	if err != nil {
		t.Fatalf("create JWT validator: %v", err)
	}
	t.Cleanup(validator.Close)
	return validator, privateKey
}

func buildWorkspaceCreateJWKS(pub *rsa.PublicKey) []byte {
	n := base64.RawURLEncoding.EncodeToString(pub.N.Bytes())
	e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes())
	data, _ := json.Marshal(map[string]interface{}{
		"keys": []map[string]interface{}{
			{
				"kty": "RSA",
				"alg": "RS256",
				"use": "sig",
				"kid": "test-key-1",
				"n":   n,
				"e":   e,
			},
		},
	})
	return data
}

func signWorkspaceCreateNodeToken(t *testing.T, key *rsa.PrivateKey, nodeID, workspaceID string) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, auth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "test-issuer",
			Subject:   nodeID,
			Audience:  jwt.ClaimStrings{"node-management"},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
		Node:      nodeID,
		Workspace: workspaceID,
	})
	token.Header["kid"] = "test-key-1"
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return signed
}

func postCreateWorkspace(t *testing.T, s *Server, token, workspaceID string) *httptest.ResponseRecorder {
	t.Helper()
	body := []byte(`{"workspaceId":"` + workspaceID + `","repository":"owner/repo","branch":"main","callbackToken":"callback-token"}`)
	req := httptest.NewRequest(http.MethodPost, "/workspaces", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-SAM-Node-Id", "node-1")
	req.Header.Set("X-SAM-Workspace-Id", workspaceID)
	rec := httptest.NewRecorder()
	s.handleCreateWorkspace(rec, req)
	return rec
}

func waitForProvisioningCalls(t *testing.T, calls *int32, want int32) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(calls) >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d provisioning calls, got %d", want, atomic.LoadInt32(calls))
}

func waitForProvisioningInactive(t *testing.T, s *Server, workspaceID string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		s.workspaceMu.RLock()
		runtime := s.workspaces[workspaceID]
		active := runtime != nil && runtime.ProvisioningActive
		s.workspaceMu.RUnlock()
		if !active {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for provisioning flag to clear for %s", workspaceID)
}

func TestStopAllWorkspacesAndSessions(t *testing.T) {
	ptyManager := pty.NewManager(pty.ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		WorkDir:      "/tmp",
		BufferSize:   1024,
	})

	sessionManager := agentsessions.NewManager()
	if _, _, err := sessionManager.Create("ws-1", "sess-1", "Session 1", ""); err != nil {
		t.Fatalf("create agent session: %v", err)
	}

	s := &Server{
		config: &config.Config{
			NodeID: "node-1",
		},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-1": {
				ID:        "ws-1",
				Status:    "running",
				CreatedAt: time.Now().UTC(),
				UpdatedAt: time.Now().UTC(),
				PTY:       ptyManager,
			},
		},
		nodeEvents:      make([]EventRecord, 0),
		workspaceEvents: map[string][]EventRecord{},
		agentSessions:   sessionManager,
		sessionHosts:    map[string]*acp.SessionHost{},
	}

	s.StopAllWorkspacesAndSessions()

	runtime, ok := s.getWorkspaceRuntime("ws-1")
	if !ok {
		t.Fatalf("workspace runtime missing after stop")
	}
	if runtime.Status != "stopped" {
		t.Fatalf("expected workspace status stopped, got %s", runtime.Status)
	}

	session, ok := sessionManager.Get("ws-1", "sess-1")
	if !ok {
		t.Fatalf("expected session to exist")
	}
	if session.Status != agentsessions.StatusStopped {
		t.Fatalf("expected session status stopped, got %s", session.Status)
	}
}

func TestWorkspaceManagementSourceContractIncludesRebuild(t *testing.T) {
	path := filepath.Join("workspaces.go")
	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	content := string(contentBytes)

	for _, needle := range []string{
		"handleRebuildWorkspace",
	} {
		if !strings.Contains(content, needle) {
			t.Fatalf("expected %q in %s", needle, path)
		}
	}
}

func TestRebuildHandlerRejectsInvalidStatus(t *testing.T) {
	ptyManager := pty.NewManager(pty.ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		WorkDir:      "/tmp",
		BufferSize:   1024,
	})

	s := &Server{
		config: &config.Config{
			NodeID: "node-1",
		},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-creating": {
				ID:        "ws-creating",
				Status:    "creating",
				CreatedAt: time.Now().UTC(),
				UpdatedAt: time.Now().UTC(),
				PTY:       ptyManager,
			},
			"ws-stopped": {
				ID:        "ws-stopped",
				Status:    "stopped",
				CreatedAt: time.Now().UTC(),
				UpdatedAt: time.Now().UTC(),
				PTY:       ptyManager,
			},
			"ws-running": {
				ID:        "ws-running",
				Status:    "running",
				CreatedAt: time.Now().UTC(),
				UpdatedAt: time.Now().UTC(),
				PTY:       ptyManager,
			},
			"ws-error": {
				ID:        "ws-error",
				Status:    "error",
				CreatedAt: time.Now().UTC(),
				UpdatedAt: time.Now().UTC(),
				PTY:       ptyManager,
			},
			"ws-recovery": {
				ID:        "ws-recovery",
				Status:    "recovery",
				CreatedAt: time.Now().UTC(),
				UpdatedAt: time.Now().UTC(),
				PTY:       ptyManager,
			},
		},
		nodeEvents:      make([]EventRecord, 0),
		workspaceEvents: map[string][]EventRecord{},
		agentSessions:   agentsessions.NewManager(),
		sessionHosts:    map[string]*acp.SessionHost{},
	}

	// "creating" status should be rejected
	runtime, _ := s.getWorkspaceRuntime("ws-creating")
	if runtime.Status == "running" || runtime.Status == "error" {
		t.Fatal("expected creating status")
	}

	// "stopped" status should be rejected
	runtime, _ = s.getWorkspaceRuntime("ws-stopped")
	if runtime.Status == "running" || runtime.Status == "error" {
		t.Fatal("expected stopped status")
	}

	// "running" should be accepted
	runtime, _ = s.getWorkspaceRuntime("ws-running")
	if runtime.Status != "running" {
		t.Fatal("expected running status")
	}

	// "error" should be accepted
	runtime, _ = s.getWorkspaceRuntime("ws-error")
	if runtime.Status != "error" {
		t.Fatal("expected error status")
	}

	// "recovery" should be accepted
	runtime, _ = s.getWorkspaceRuntime("ws-recovery")
	if runtime.Status != "recovery" {
		t.Fatal("expected recovery status")
	}
}
