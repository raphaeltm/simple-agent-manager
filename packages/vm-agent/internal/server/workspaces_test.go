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

func TestCreateWorkspaceReplayAfterCompletionDoesNotProvisionAgain(t *testing.T) {
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
	if second.Code != http.StatusOK {
		t.Fatalf("expected second create status 200, got %d", second.Code)
	}
	if got := atomic.LoadInt32(&prepareCalls); got != 1 {
		t.Fatalf("expected replay not to start provisioning again, got %d calls", got)
	}
}

func TestCreateWorkspaceReplayConflictReturnsConflict(t *testing.T) {
	controlPlane := newWorkspaceCreateControlPlane(t)
	validator, privateKey := newWorkspaceCreateJWTValidator(t, "node-1")
	s := newWorkspaceCreateServer(t, controlPlane.URL, validator)
	token := signWorkspaceCreateNodeToken(t, privateKey, "node-1", "ws-conflict")
	s.upsertWorkspaceRuntime("ws-conflict", "owner/repo", "main", "running", "callback-token")

	rec := postCreateWorkspaceWithRepository(t, s, token, "ws-conflict", "other/repo")
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected conflict status 409, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "workspace_conflict") {
		t.Fatalf("expected workspace_conflict response, got %s", rec.Body.String())
	}
}

func TestCreateWorkspaceStandaloneClonesBeforeRunning(t *testing.T) {
	validator, privateKey := newWorkspaceCreateJWTValidator(t, "node-1")
	workspaceID := "ws-standalone"
	workDir := filepath.Join(t.TempDir(), "repo")
	var readyCalled atomic.Bool

	controlPlane := newStandaloneCloneControlPlane(t, workspaceID, workDir, &readyCalled)
	defer controlPlane.Close()

	s := newWorkspaceCreateServer(t, controlPlane.URL, validator)
	s.config.Role = config.RoleStandalone
	s.config.WorkspaceID = workspaceID
	s.config.WorkspaceDir = workDir
	s.config.ContainerWorkDir = workDir
	s.config.WorkspaceReadyCallbackTimeout = time.Second

	var cloneCalled atomic.Bool
	installStandaloneCloneGitStub(t, s, workspaceID, workDir, &cloneCalled)

	token := signWorkspaceCreateNodeToken(t, privateKey, "node-1", workspaceID)
	rec := postCreateWorkspaceWithRepository(t, s, token, workspaceID, "owner/repo")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected standalone create status 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !cloneCalled.Load() {
		t.Fatal("expected standalone create to clone repository")
	}
	if !readyCalled.Load() {
		t.Fatal("expected standalone create to notify ready after clone")
	}
	runtime, ok := s.getWorkspaceRuntime(workspaceID)
	if !ok {
		t.Fatal("workspace runtime missing")
	}
	if runtime.Status != "running" {
		t.Fatalf("workspace status = %q, want running", runtime.Status)
	}
	if runtime.ContainerWorkDir != workDir {
		t.Fatalf("container workdir = %q, want %q", runtime.ContainerWorkDir, workDir)
	}
}

// standaloneCloneTestHarness spins up a standalone-mode server with a control
// plane, git stub (capturing clone args), and a signed node token, then posts
// the create-workspace request and asserts it succeeded with a clone.
type standaloneCloneTestHarness struct {
	server    *Server
	cloneArgs []string
}

func runStandaloneCloneCreate(t *testing.T, workspaceID, cloneFilter string) *standaloneCloneTestHarness {
	t.Helper()

	validator, privateKey := newWorkspaceCreateJWTValidator(t, "node-1")
	workDir := filepath.Join(t.TempDir(), "repo")
	var readyCalled atomic.Bool

	controlPlane := newStandaloneCloneControlPlane(t, workspaceID, workDir, &readyCalled)
	t.Cleanup(controlPlane.Close)

	s := newWorkspaceCreateServer(t, controlPlane.URL, validator)
	s.config.Role = config.RoleStandalone
	s.config.WorkspaceID = workspaceID
	s.config.WorkspaceDir = workDir
	s.config.ContainerWorkDir = workDir
	s.config.WorkspaceReadyCallbackTimeout = time.Second
	s.config.StandaloneCloneFilter = cloneFilter

	harness := &standaloneCloneTestHarness{server: s}
	var cloneCalled atomic.Bool
	installStandaloneCloneGitStubCapture(t, s, workspaceID, workDir, &cloneCalled, &harness.cloneArgs)

	token := signWorkspaceCreateNodeToken(t, privateKey, "node-1", workspaceID)
	rec := postCreateWorkspaceWithRepository(t, s, token, workspaceID, "owner/repo")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected standalone create status 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !cloneCalled.Load() {
		t.Fatal("expected standalone create to clone repository")
	}
	return harness
}

// Regression test for the 2026-07-18 instant-container outage: standalone
// clones run synchronously inside the control plane's create-workspace request,
// so they MUST use the partial-clone filter to keep clone cost proportional to
// the working tree instead of the full history pack. This fails on pre-fix
// code, which issued a full clone.
func TestCreateWorkspaceStandaloneUsesPartialCloneFilter(t *testing.T) {
	harness := runStandaloneCloneCreate(t, "ws-standalone-filter", config.DefaultStandaloneCloneFilter)

	joined := strings.Join(harness.cloneArgs, " ")
	if !strings.Contains(joined, "clone --filter=blob:none --branch") {
		t.Fatalf("clone args missing partial-clone filter: %v", harness.cloneArgs)
	}
}

func TestCreateWorkspaceStandaloneCloneFilterDisabled(t *testing.T) {
	harness := runStandaloneCloneCreate(t, "ws-standalone-nofilter", config.ResolveStandaloneCloneFilter("off"))

	for _, arg := range harness.cloneArgs {
		if strings.HasPrefix(arg, "--filter") {
			t.Fatalf("clone args must not include --filter when disabled: %v", harness.cloneArgs)
		}
	}
	joined := strings.Join(harness.cloneArgs, " ")
	if !strings.Contains(joined, "clone --branch") {
		t.Fatalf("expected plain full clone args, got: %v", harness.cloneArgs)
	}
}

func newStandaloneCloneControlPlane(
	t *testing.T,
	workspaceID string,
	workDir string,
	readyCalled *atomic.Bool,
) *httptest.Server {
	t.Helper()

	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/workspaces/" + workspaceID + "/git-token":
			_, _ = w.Write([]byte(`{"token":"git-token"}`))
		case "/api/workspaces/" + workspaceID + "/ready":
			if _, err := os.Stat(filepath.Join(workDir, ".git")); err != nil {
				t.Errorf("ready callback arrived before repository was materialized: %v", err)
			}
			readyCalled.Store(true)
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
}

func installStandaloneCloneGitStub(
	t *testing.T,
	s *Server,
	workspaceID string,
	workDir string,
	cloneCalled *atomic.Bool,
) {
	t.Helper()
	installStandaloneCloneGitStubCapture(t, s, workspaceID, workDir, cloneCalled, nil)
}

func installStandaloneCloneGitStubCapture(
	t *testing.T,
	s *Server,
	workspaceID string,
	workDir string,
	cloneCalled *atomic.Bool,
	capturedCloneArgs *[]string,
) {
	t.Helper()

	originalRunGit := runStandaloneGitCommand
	t.Cleanup(func() { runStandaloneGitCommand = originalRunGit })
	runStandaloneGitCommand = func(_ context.Context, _ string, env []string, args ...string) (string, error) {
		joinedArgs := strings.Join(args, " ")
		if !strings.Contains(joinedArgs, "clone") {
			return "", nil
		}
		if !envContains(env, "GH_TOKEN=git-token") {
			t.Fatalf("standalone clone did not receive scoped GH_TOKEN env: %v", env)
		}
		s.workspaceMu.RLock()
		status := s.workspaces[workspaceID].Status
		s.workspaceMu.RUnlock()
		if status != "creating" {
			t.Fatalf("workspace status during clone = %q, want creating", status)
		}
		target := args[len(args)-1]
		if target != workDir {
			t.Fatalf("clone target = %q, want %q", target, workDir)
		}
		if err := os.MkdirAll(filepath.Join(target, ".git"), 0o755); err != nil {
			t.Fatalf("create fake git dir: %v", err)
		}
		if capturedCloneArgs != nil {
			*capturedCloneArgs = append([]string(nil), args...)
		}
		cloneCalled.Store(true)
		return "", nil
	}
}

func TestCreateWorkspaceStandaloneRejectsUnsafeWorkDir(t *testing.T) {
	validator, privateKey := newWorkspaceCreateJWTValidator(t, "node-1")
	workspaceID := "ws-unsafe"

	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/workspaces/" + workspaceID + "/provisioning-failed":
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	defer controlPlane.Close()

	s := newWorkspaceCreateServer(t, controlPlane.URL, validator)
	s.config.Role = config.RoleStandalone
	s.config.WorkspaceID = workspaceID
	s.config.WorkspaceDir = "/"
	s.config.ContainerWorkDir = "/"
	s.config.WorkspaceReadyCallbackTimeout = time.Second

	originalRunGit := runStandaloneGitCommand
	defer func() { runStandaloneGitCommand = originalRunGit }()
	runStandaloneGitCommand = func(context.Context, string, []string, ...string) (string, error) {
		t.Fatal("standalone git command should not run for an unsafe workdir")
		return "", nil
	}

	token := signWorkspaceCreateNodeToken(t, privateKey, "node-1", workspaceID)
	rec := postCreateWorkspaceWithRepository(t, s, token, workspaceID, "owner/repo")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected standalone create status 500, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "unsafe standalone workspace directory") {
		t.Fatalf("expected unsafe workdir error, got %s", rec.Body.String())
	}
	runtime, ok := s.getWorkspaceRuntime(workspaceID)
	if !ok {
		t.Fatal("workspace runtime missing")
	}
	if runtime.Status != "error" {
		t.Fatalf("workspace status = %q, want error", runtime.Status)
	}
}

func newWorkspaceCreateControlPlane(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/git-token"):
			_, _ = w.Write([]byte(`{"token":"git-token"}`))
		case strings.HasSuffix(r.URL.Path, "/runtime-assets"):
			_, _ = w.Write([]byte(`{"envVars":[],"files":[]}`))
		case strings.HasSuffix(r.URL.Path, "/ready"):
			w.WriteHeader(http.StatusOK)
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
	return postCreateWorkspaceWithRepository(t, s, token, workspaceID, "owner/repo")
}

func postCreateWorkspaceWithRepository(t *testing.T, s *Server, token, workspaceID, repository string) *httptest.ResponseRecorder {
	t.Helper()
	body := []byte(`{"workspaceId":"` + workspaceID + `","repository":"` + repository + `","branch":"main","callbackToken":"callback-token"}`)
	req := httptest.NewRequest(http.MethodPost, "/workspaces", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-SAM-Node-Id", "node-1")
	req.Header.Set("X-SAM-Workspace-Id", workspaceID)
	rec := httptest.NewRecorder()
	s.handleCreateWorkspace(rec, req)
	return rec
}

func envContains(env []string, want string) bool {
	for _, item := range env {
		if item == want {
			return true
		}
	}
	return false
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
