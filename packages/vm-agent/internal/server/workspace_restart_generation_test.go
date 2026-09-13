package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/persistence"
)

const restartTestGeneration = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
const restartTestNextGeneration = "01ARZ3NDEKTSV4RRFFQ69G5FAW"

func TestWorkspaceRestartGenerationValidation(t *testing.T) {
	for _, tt := range []struct {
		name, body string
		want       int
	}{
		{"missing", "", http.StatusBadRequest},
		{"empty object", "{}", http.StatusBadRequest},
		{"malformed", "{", http.StatusBadRequest},
		{"invalid generation", `{"evictionGeneration":"bad","expectedEvictionGeneration":""}`, http.StatusBadRequest},
		{"missing expected", `{"evictionGeneration":"` + restartTestGeneration + `"}`, http.StatusBadRequest},
		{"stale expected", `{"evictionGeneration":"` + restartTestNextGeneration + `","expectedEvictionGeneration":"` + restartTestGeneration + `"}`, http.StatusConflict},
		{"trailing body", `{"evictionGeneration":"` + restartTestGeneration + `","expectedEvictionGeneration":""}{}`, http.StatusBadRequest},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s, token, finish := newRestartGenerationTestServer(t, "evicted")
			defer finish(errors.New("test complete"))
			before := s.snapshotWorkspaceRuntime(s.workspaces["ws-restart"])
			rec := postWorkspaceReprovision(t, s, token, "restart", tt.body)
			if rec.Code != tt.want {
				t.Fatalf("got %d: %s; want %d", rec.Code, rec.Body.String(), tt.want)
			}
			after := s.snapshotWorkspaceRuntime(s.workspaces["ws-restart"])
			if after.Status != before.Status || after.EvictionGeneration != before.EvictionGeneration || after.ProvisioningActive {
				t.Fatalf("rejected restart changed runtime: %#v", after)
			}
		})
	}
}

func TestWorkspaceRestartGenerationIsDurableBeforeProvisionAndRejectsDuplicate(t *testing.T) {
	s, token, finish := newRestartGenerationTestServer(t, "evicted")
	dockerLog := filepath.Join(t.TempDir(), "docker.log")
	dockerCLI := filepath.Join(t.TempDir(), "docker")
	if err := os.WriteFile(dockerCLI, []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SAM_RESTART_DOCKER_LOG\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SAM_DOCKER_CLI_PATH", dockerCLI)
	t.Setenv("SAM_RESTART_DOCKER_LOG", dockerLog)
	marker := filepath.Join(s.config.WorkspaceDir, "keep.txt")
	if err := os.WriteFile(marker, []byte("workspace data"), 0o600); err != nil {
		t.Fatal(err)
	}
	body := `{"evictionGeneration":"` + restartTestGeneration + `","expectedEvictionGeneration":""}`
	rec := postWorkspaceReprovision(t, s, token, "restart", body)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("restart: %d %s", rec.Code, rec.Body.String())
	}
	runtime := s.snapshotWorkspaceRuntime(s.workspaces["ws-restart"])
	meta, err := s.store.GetWorkspaceMetadata("ws-restart")
	if err != nil || meta == nil || meta.EvictionGeneration != restartTestGeneration || meta.Evicted || runtime.Status != "creating" || !runtime.ProvisioningActive || runtime.EvictionGeneration != restartTestGeneration || runtime.UpdatedAt.IsZero() {
		t.Fatalf("restart was not durable before provision: runtime=%#v metadata=%#v err=%v", runtime, meta, err)
	}
	if duplicate := postWorkspaceReprovision(t, s, token, "restart", body); duplicate.Code != http.StatusConflict {
		t.Fatalf("duplicate accepted: %d %s", duplicate.Code, duplicate.Body.String())
	}
	finish(errors.New("host setup failed"))
	waitForRestartProvisionFailure(t, s)
	if data, err := os.ReadFile(marker); err != nil || string(data) != "workspace data" {
		t.Fatalf("restart removed workspace data: %q %v", data, err)
	}
	if commands, err := os.ReadFile(dockerLog); err == nil && (strings.Contains(string(commands), "rm") || strings.Contains(string(commands), "prune")) {
		t.Fatalf("restart removed preserved Docker resources: %s", commands)
	}
	if replay := postWorkspaceReprovision(t, s, token, "restart", body); replay.Code != http.StatusConflict {
		t.Fatalf("old request replay accepted after failure: %d %s", replay.Code, replay.Body.String())
	}
	if missing := postWorkspaceReprovision(t, s, token, "restart", ""); missing.Code != http.StatusBadRequest {
		t.Fatalf("unfenced retry accepted after generation established: %d %s", missing.Code, missing.Body.String())
	}
}

func TestWorkspaceRestartPersistenceFailureDoesNotClaimRuntime(t *testing.T) {
	s, token, finish := newRestartGenerationTestServer(t, "evicted")
	defer finish(errors.New("test complete"))
	if err := s.store.Close(); err != nil {
		t.Fatal(err)
	}
	rec := postWorkspaceReprovision(t, s, token, "restart", `{"evictionGeneration":"`+restartTestGeneration+`","expectedEvictionGeneration":""}`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("got %d: %s", rec.Code, rec.Body.String())
	}
	runtime := s.snapshotWorkspaceRuntime(s.workspaces["ws-restart"])
	if runtime.Status != "evicted" || runtime.EvictionGeneration != "" || runtime.ProvisioningActive {
		t.Fatalf("failed persistence changed runtime: %#v", runtime)
	}
}

func TestWorkspaceReprovisionLegacyAndRebuildGeneration(t *testing.T) {
	for _, tt := range []struct{ name, status, action, body, generation string }{
		{"legacy stopped", "stopped", "restart", "", ""},
		{"legacy error", "error", "restart", "", ""},
		{"fenced rebuild", "running", "rebuild", `{"evictionGeneration":"` + restartTestGeneration + `","expectedEvictionGeneration":""}`, restartTestGeneration},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s, token, finish := newRestartGenerationTestServer(t, tt.status)
			rec := postWorkspaceReprovision(t, s, token, tt.action, tt.body)
			if rec.Code != http.StatusAccepted {
				t.Fatalf("got %d: %s", rec.Code, rec.Body.String())
			}
			if generation := s.snapshotWorkspaceRuntime(s.workspaces["ws-restart"]).EvictionGeneration; generation != tt.generation {
				t.Fatalf("generation = %q, want %q", generation, tt.generation)
			}
			finish(errors.New("host setup failed"))
			waitForRestartProvisionFailure(t, s)
		})
	}
}

func TestWorkspaceRuntimeHydratesAndPreservesEvictionGeneration(t *testing.T) {
	s, _, finish := newRestartGenerationTestServer(t, "stopped")
	defer finish(errors.New("test complete"))
	if changed, err := s.store.CompareAndSwapWorkspaceEvictionGeneration("ws-restart", "", restartTestGeneration); err != nil || !changed {
		t.Fatalf("advance persisted fence: %v %v", changed, err)
	}
	delete(s.workspaces, "ws-restart")
	runtime := s.upsertWorkspaceRuntime("ws-restart", "owner/repo", "main", "running", "", workspaceRuntimeOpts{EvictionGeneration: restartTestNextGeneration})
	if runtime.EvictionGeneration != restartTestGeneration {
		t.Fatalf("hydrate lost persisted fence: %q", runtime.EvictionGeneration)
	}
	s.upsertWorkspaceRuntime("ws-restart", "owner/repo", "changed", "", "", workspaceRuntimeOpts{EvictionGeneration: restartTestNextGeneration})
	if runtime.EvictionGeneration != restartTestGeneration {
		t.Fatalf("normal metadata overwrite changed fence: %q", runtime.EvictionGeneration)
	}
}

func newRestartGenerationTestServer(t *testing.T, status string) (*Server, string, func(error)) {
	t.Helper()
	validator, key := newWorkspaceCreateJWTValidator(t, "node-1")
	s := newWorkspaceCreateServer(t, "http://127.0.0.1:1", validator)
	s.config.CallbackToken = ""
	s.done = make(chan struct{})
	s.config.MaxNodeEvents = 100
	s.config.MaxWorkspaceEvents = 100
	store, err := persistence.Open(filepath.Join(t.TempDir(), "metadata.db"))
	if err != nil {
		t.Fatal(err)
	}
	s.store = store
	t.Cleanup(func() { _ = store.Close() })
	s.upsertWorkspaceRuntime("ws-restart", "owner/repo", "main", status, "")
	finish := s.BeginSystemProvisioning()
	t.Cleanup(func() { finish(errors.New("test complete")) })
	return s, signWorkspaceCreateNodeToken(t, key, "node-1", "ws-restart"), finish
}

func postWorkspaceReprovision(t *testing.T, s *Server, token, action, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/workspaces/ws-restart/"+action, strings.NewReader(body))
	req.SetPathValue("workspaceId", "ws-restart")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-SAM-Node-Id", "node-1")
	req.Header.Set("X-SAM-Workspace-Id", "ws-restart")
	rec := httptest.NewRecorder()
	if action == "rebuild" {
		s.handleRebuildWorkspace(rec, req)
	} else {
		s.handleRestartWorkspace(rec, req)
	}
	return rec
}

func waitForRestartProvisionFailure(t *testing.T, s *Server) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		runtime := s.snapshotWorkspaceRuntime(s.workspaces["ws-restart"])
		if runtime.Status == "error" && !runtime.ProvisioningActive {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("workspace provision did not finish with expected failure")
}

func TestEvictedWorkspaceReconnectAndRecoveryRemainBlockedAfterAgentRestart(t *testing.T) {
	for _, reload := range []bool{false, true} {
		t.Run(fmt.Sprintf("reload=%t", reload), func(t *testing.T) {
			s, _, finish := newRestartGenerationTestServer(t, "evicted")
			finish(errors.New("host setup must not be reached"))
			if reload {
				// A fresh runtime map represents VM-agent process recovery. Durable
				// metadata, not the browser's requested status, is authoritative.
				s.workspaces = make(map[string]*WorkspaceRuntime)
			}
			s.sessionManager = auth.NewSessionManager("session", false, time.Hour)
			session, err := s.sessionManager.CreateSession(&auth.Claims{Workspace: "ws-restart"})
			if err != nil {
				t.Fatal(err)
			}
			for _, handler := range []http.HandlerFunc{s.handleTerminalWS, s.handleMultiTerminalWS, s.handleAgentWS} {
				req := httptest.NewRequest(http.MethodGet, "/ws", nil)
				req.Header.Set("X-SAM-Workspace-Id", "ws-restart")
				req.AddCookie(&http.Cookie{Name: "session", Value: session.ID})
				rec := httptest.NewRecorder()
				handler(rec, req)
				if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "evicted") {
					t.Fatalf("evicted reconnect accepted: %d %s", rec.Code, rec.Body.String())
				}
			}
			runtime := s.workspaces["ws-restart"]
			if runtime.Status != "evicted" {
				t.Fatalf("browser revived runtime as %q", runtime.Status)
			}
			if err := s.recoverWorkspaceRuntime(context.Background(), runtime); !errors.Is(err, errWorkspaceNotRunning) {
				t.Fatalf("recovery bypassed eviction: %v", err)
			}
		})
	}
}

func TestWorkspaceRestartWaitsForLifecycleLockAndRevalidatesGeneration(t *testing.T) {
	s, token, finish := newRestartGenerationTestServer(t, "evicted")
	defer finish(errors.New("test complete"))
	lock := s.workspaceLifecycleLock("ws-restart")
	if err := lock.Lock(context.Background()); err != nil {
		t.Fatal(err)
	}
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		result <- postWorkspaceReprovision(t, s, token, "restart", `{"evictionGeneration":"`+restartTestNextGeneration+`","expectedEvictionGeneration":""}`)
	}()
	select {
	case rec := <-result:
		t.Fatalf("restart bypassed lifecycle lock: %d", rec.Code)
	case <-time.After(20 * time.Millisecond):
	}
	if changed, err := s.store.CompareAndSwapWorkspaceEvictionGeneration("ws-restart", "", restartTestGeneration); err != nil || !changed {
		t.Fatalf("advance preceding lifecycle: %v %v", changed, err)
	}
	s.workspaceMu.Lock()
	s.workspaces["ws-restart"].EvictionGeneration = restartTestGeneration
	s.workspaceMu.Unlock()
	lock.Unlock()
	select {
	case rec := <-result:
		if rec.Code != http.StatusConflict {
			t.Fatalf("stale queued restart accepted: %d %s", rec.Code, rec.Body.String())
		}
	case <-time.After(time.Second):
		t.Fatal("restart did not finish after lifecycle lock release")
	}
}

func TestWorkspaceRestartCanceledWhileLifecycleLockedDoesNotMutate(t *testing.T) {
	s, token, finish := newRestartGenerationTestServer(t, "evicted")
	defer finish(errors.New("test complete"))
	lock := s.workspaceLifecycleLock("ws-restart")
	if err := lock.Lock(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer lock.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest(http.MethodPost, "/workspaces/ws-restart/restart", strings.NewReader(`{"evictionGeneration":"`+restartTestGeneration+`","expectedEvictionGeneration":""}`)).WithContext(ctx)
	req.SetPathValue("workspaceId", "ws-restart")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-SAM-Workspace-Id", "ws-restart")
	rec := httptest.NewRecorder()
	s.handleRestartWorkspace(rec, req)
	if rec.Code != http.StatusRequestTimeout {
		t.Fatalf("canceled restart: %d %s", rec.Code, rec.Body.String())
	}
	if runtime := s.snapshotWorkspaceRuntime(s.workspaces["ws-restart"]); runtime.Status != "evicted" || runtime.ProvisioningActive || runtime.EvictionGeneration != "" {
		t.Fatalf("canceled request changed runtime: %#v", runtime)
	}
}

func TestEvictionMetadataReadFailureCannotBecomeRunning(t *testing.T) {
	s, _, finish := newRestartGenerationTestServer(t, "evicted")
	defer finish(errors.New("test complete"))
	if err := s.store.Close(); err != nil {
		t.Fatal(err)
	}
	s.workspaces = make(map[string]*WorkspaceRuntime)
	runtime := s.upsertWorkspaceRuntime("ws-restart", "", "", "running", "")
	if !runtime.MetadataUnavailable || runtime.Status == "running" {
		t.Fatalf("failed metadata read revived workspace: %#v", runtime)
	}
	if err := s.recoverWorkspaceRuntime(context.Background(), runtime); !errors.Is(err, errWorkspaceMetadataUnavailable) {
		t.Fatalf("recovery ignored unknown eviction state: %v", err)
	}
	rec := httptest.NewRecorder()
	if s.requireWorkspaceReconnectState(rec, httptest.NewRequest(http.MethodGet, "/ws", nil), runtime) || rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("reconnect accepted unknown eviction state: %d", rec.Code)
	}
}

func TestPreparedEvictionIntentBlocksRecoveryAndUnfencedRebuild(t *testing.T) {
	s, token, finish := newRestartGenerationTestServer(t, "evicted")
	defer finish(errors.New("test complete"))
	// Simulate a prepared durable stop intent whose Docker stop failed before
	// the in-memory status could be finalized.
	runtime := s.workspaces["ws-restart"]
	runtime.Status = "running"
	if err := s.recoverWorkspaceRuntime(context.Background(), runtime); !errors.Is(err, errWorkspaceNotRunning) {
		t.Fatalf("recovery ignored prepared eviction: %v", err)
	}
	runtime.Status = "running"
	if rec := postWorkspaceReprovision(t, s, token, "rebuild", ""); rec.Code != http.StatusConflict {
		t.Fatalf("unfenced rebuild ignored prepared eviction: %d %s", rec.Code, rec.Body.String())
	}
	if runtime.Status != "evicted" {
		t.Fatalf("durable intent did not restore evicted status: %q", runtime.Status)
	}
}

func TestEvictedWorkspaceCreateReplayCannotProvisionAfterAgentRestart(t *testing.T) {
	for _, standalone := range []bool{false, true} {
		t.Run(fmt.Sprintf("standalone=%t", standalone), func(t *testing.T) {
			s, token, finish := newRestartGenerationTestServer(t, "evicted")
			defer finish(errors.New("provisioning must not start"))
			if standalone {
				s.config.Role = config.RoleStandalone
			}
			s.workspaces = make(map[string]*WorkspaceRuntime)
			rec := postCreateWorkspaceWithRepository(t, s, token, "ws-restart", "owner/repo")
			if rec.Code != http.StatusConflict {
				t.Fatalf("create replay accepted: %d %s", rec.Code, rec.Body.String())
			}
			meta, err := s.store.GetWorkspaceMetadata("ws-restart")
			if err != nil || meta == nil || !meta.Evicted || meta.CallbackToken != "" {
				t.Fatalf("rejected create changed durable state: %#v %v", meta, err)
			}
			if runtime, ok := s.getWorkspaceRuntime("ws-restart"); ok && runtime.ProvisioningActive {
				t.Fatal("replayed create started provisioning")
			}
		})
	}
}

func TestWorkspaceBootstrapRestoresFenceAndSkipsPreservedEvictedOverlay(t *testing.T) {
	s, _, finish := newRestartGenerationTestServer(t, "evicted")
	defer finish(errors.New("test complete"))
	const workspaceID = "boot-workspace"
	if err := s.store.UpsertWorkspaceMetadata(persistence.WorkspaceMetadata{WorkspaceID: workspaceID, Repository: "owner/repo", ProjectID: "project-1", Evicted: true, EvictionGeneration: restartTestGeneration}); err != nil {
		t.Fatal(err)
	}
	cfg := *s.config
	cfg.WorkspaceID = workspaceID
	cfg.BootstrapToken = "configured-bootstrap-token"
	// Real bootstrap.Run would fail on this state path if the guard let it run.
	cfg.BootstrapStatePath = t.TempDir()
	if err := s.initializeBootWorkspace(&cfg, s.workspaces["ws-restart"].PTY); err != nil {
		t.Fatal(err)
	}
	runtime := s.workspaces[workspaceID]
	if runtime.Status != "evicted" || runtime.EvictionGeneration != restartTestGeneration || runtime.ProjectID != "project-1" {
		t.Fatalf("boot initialization lost durable fence: %#v", runtime)
	}
	// Prepared intents can exist while the old process still thought it running.
	runtime.Status = "running"
	if err := s.BootstrapWorkspace(context.Background(), &cfg, nil); err != nil {
		t.Fatalf("evicted bootstrap should remain dormant: %v", err)
	}
	if runtime.Status != "evicted" || s.bootstrapComplete.Load() {
		t.Fatal("legacy bootstrap advertised an evicted workspace as ready")
	}
}

func TestWorkspaceLifecycleLockReclaimsEntriesAfterWaitersAndCancellation(t *testing.T) {
	s := &Server{}
	first := s.workspaceLifecycleLock("ws")
	if err := first.Lock(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := s.workspaceLifecycleLock("ws").Lock(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("second lock bypassed holder: %v", err)
	}
	if len(s.workspaceLifecycleLocks) != 1 {
		t.Fatal("canceling waiter removed active lock")
	}
	first.Unlock()
	if len(s.workspaceLifecycleLocks) != 0 {
		t.Fatal("completed workspace lock leaked")
	}
	for i := 0; i < 100; i++ {
		lock := s.workspaceLifecycleLock(fmt.Sprintf("workspace-%d", i))
		if err := lock.Lock(context.Background()); err != nil {
			t.Fatal(err)
		}
		lock.Unlock()
	}
	if len(s.workspaceLifecycleLocks) != 0 {
		t.Fatal("historical workspace lifecycle entries accumulated")
	}
}

func TestWorkspaceRuntimeHydratesPersistedProjectIdentity(t *testing.T) {
	s, _, finish := newRestartGenerationTestServer(t, "running")
	defer finish(errors.New("test complete"))
	s.upsertWorkspaceRuntime("ws-restart", "", "", "", "", workspaceRuntimeOpts{ProjectID: "project-1", ChatSessionID: "chat-1"})
	s.workspaces = make(map[string]*WorkspaceRuntime)
	runtime := s.upsertWorkspaceRuntime("ws-restart", "", "", "running", "")
	if runtime.ProjectID != "project-1" || runtime.ChatSessionID != "chat-1" {
		t.Fatalf("dynamic workspace lost callback identity: %#v", runtime)
	}
	s.upsertWorkspaceRuntime("ws-restart", "", "", "", "", workspaceRuntimeOpts{ProjectID: "unrelated-project"})
	if runtime.ProjectID != "project-1" {
		t.Fatal("ordinary update replaced project identity")
	}
}
