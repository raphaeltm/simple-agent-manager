package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/config"
)

// Exercise the real managed restore handler and snapshot/provision call chain.
// Only the control-plane transport and host bootstrap boundary are replaced.
func TestManagedSnapshotRestoreProvisionsUnderExistingLifecycleOwnership(t *testing.T) {
	fixture := newDeletionFixture(t)
	server := fixture.server
	server.sessionProfileOvr = make(map[string]profileOverrides)
	server.config.SessionSnapshotOperationTimeout = 5 * time.Second
	server.config.SessionSnapshotProgressReportTimeout = time.Second
	runtime := server.upsertWorkspaceRuntime("workspace-1", "", "main", "running", "fresh", workspaceRuntimeOpts{ProjectID: "project"})
	if _, _, err := server.agentSessions.CreateRouted("workspace-1", "session", "Original", "", "project", "chat"); err != nil {
		t.Fatal(err)
	}
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(r.URL.Path, "session-snapshot/restore-result"):
			_, _ = w.Write([]byte(`{}`))
		case strings.Contains(r.URL.Path, "session-snapshot/restore"):
			_, _ = w.Write([]byte(`{"available":true}`))
		case strings.HasSuffix(r.URL.Path, "git-token"):
			_, _ = w.Write([]byte(`{"token":"test-token"}`))
		case strings.HasSuffix(r.URL.Path, "runtime-assets"):
			_, _ = w.Write([]byte(`{"envVars":[],"files":[]}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer controlPlane.Close()
	server.config.ControlPlaneURL = controlPlane.URL
	started, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	originalPrepare := prepareWorkspaceForRuntime
	prepareWorkspaceForRuntime = func(ctx context.Context, cfg *config.Config, _ bootstrap.ProvisionState, _ *bootlog.Reporter) (bool, error) {
		if cfg.WorkspaceID != "workspace-1" || cfg.WorkspaceDir != fixture.root {
			t.Error("managed restore lost runtime identity")
		}
		close(started)
		select {
		case <-release:
		case <-ctx.Done():
			return false, ctx.Err()
		}
		return false, errors.New("injected host bootstrap failure after restore admission")
	}
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
		server.cancelAndWaitSessionRestores()
		prepareWorkspaceForRuntime = originalPrepare
	})
	restoreDone := make(chan struct{})
	restoreResponse := httptest.NewRecorder()
	go func() {
		defer close(restoreDone)
		request := httptest.NewRequest(http.MethodPost, "/workspaces/workspace-1/agent-sessions/session/restore", strings.NewReader(`{"chatSessionId":"chat","runtime":"vm","agentType":"claude-code","workspaceCallbackToken":"fresh"}`))
		request.SetPathValue("workspaceId", "workspace-1")
		request.SetPathValue("sessionId", "session")
		request.Header.Set("Authorization", "Bearer "+fixture.token)
		request.Header.Set("X-SAM-Workspace-Id", "workspace-1")
		server.handleRestoreAgentSession(restoreResponse, request)
	}()
	select {
	case <-started:
	case <-restoreDone:
		t.Fatalf("restore rejected before provisioning: %d %s", restoreResponse.Code, restoreResponse.Body.String())
	case <-time.After(3 * time.Second):
		t.Fatal("managed restore deadlocked before reaching host provisioning")
	}
	deleteDone := make(chan struct{})
	var deleteResponse *httptest.ResponseRecorder
	go func() { defer close(deleteDone); deleteResponse = fixture.request(t.Context(), fixture.identity) }()
	waitForRestoreLifecycleState(t, func() bool {
		server.workspaceLifecycleMu.Lock()
		defer server.workspaceLifecycleMu.Unlock()
		entry := server.workspaceLifecycleLocks[runtime.ID]
		return entry != nil && entry.users >= 2
	}, "physical deletion did not wait for the accepted managed restore")
	select {
	case <-deleteDone:
		t.Fatal("physical deletion completed while managed restore owned lifecycle")
	default:
	}
	if payload, err := server.store.GetWorkspaceDeletion(runtime.ID); err != nil || payload != "" {
		t.Fatalf("waiting deletion acquired authority during restore: %q %v", payload, err)
	}
	if data, err := os.ReadFile(filepath.Join(fixture.root, "untracked.txt")); err != nil || len(data) == 0 {
		t.Fatal("restore waiter lost user data", err)
	}
	releaseOnce.Do(func() { close(release) })
	awaitRestoreLifecycleSignal(t, restoreDone, "real managed restore did not settle after host provisioning returned")
	if restoreResponse.Code != 200 || !strings.Contains(restoreResponse.Body.String(), "degraded") {
		t.Fatalf("restore failed to finish through its error boundary: %d %s", restoreResponse.Code, restoreResponse.Body.String())
	}
	awaitRestoreLifecycleSignal(t, deleteDone, "physical deletion stayed blocked after managed restore settled")
	if deleteResponse.Code != 503 {
		t.Fatalf("deletion did not reach intentional partial-failure boundary: %d %s", deleteResponse.Code, deleteResponse.Body.String())
	}
}
