package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/config"
)

func TestWorkspaceProvisionQueuedUntilSystemProvisioningCompletes(t *testing.T) {
	originalPrepare := prepareWorkspaceForRuntime
	defer func() { prepareWorkspaceForRuntime = originalPrepare }()

	started := make(chan struct{}, 1)
	prepareWorkspaceForRuntime = func(_ context.Context, _ *config.Config, _ bootstrap.ProvisionState, _ *bootlog.Reporter) (bool, error) {
		started <- struct{}{}
		return false, nil
	}

	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/workspaces/WS_QUEUED/git-token":
			_, _ = w.Write([]byte(`{"token":"ghs_test","expiresAt":"2026-12-31T00:00:00Z"}`))
		case "/api/workspaces/WS_QUEUED/runtime-assets":
			_, _ = w.Write([]byte(`{"workspaceId":"WS_QUEUED","envVars":[],"files":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer controlPlane.Close()

	s := newQueueTestServer(controlPlane.URL)
	runtime := newQueueTestRuntime("WS_QUEUED")
	s.workspaces[runtime.ID] = runtime

	s.BlockWorkspaceProvisioning()
	s.startWorkspaceProvision(runtime, "workspace.failed", "Workspace failed", "workspace.created", "Workspace created", map[string]interface{}{"workspaceId": runtime.ID})

	select {
	case <-started:
		t.Fatal("workspace provisioning started before system provisioning completed")
	case <-time.After(50 * time.Millisecond):
	}

	if got := len(s.provisionQueue); got != 1 {
		t.Fatalf("provisionQueue length = %d, want 1", got)
	}
	assertWorkspaceEvent(t, s, runtime.ID, "workspace.queued")

	s.CompleteWorkspaceProvisioning()

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("queued workspace provisioning did not start after system provisioning completed")
	}
}

func TestQueuedWorkspaceProvisionFailsWhenSystemProvisioningFails(t *testing.T) {
	originalPrepare := prepareWorkspaceForRuntime
	defer func() { prepareWorkspaceForRuntime = originalPrepare }()

	prepareWorkspaceForRuntime = func(_ context.Context, _ *config.Config, _ bootstrap.ProvisionState, _ *bootlog.Reporter) (bool, error) {
		t.Fatal("queued workspace provisioning should not start after system provisioning failure")
		return false, nil
	}

	s := newQueueTestServer("http://127.0.0.1")
	runtime := newQueueTestRuntime("WS_FAILED")
	s.workspaces[runtime.ID] = runtime

	s.BlockWorkspaceProvisioning()
	s.startWorkspaceProvision(runtime, "workspace.provisioning_failed", "Workspace provisioning failed", "workspace.created", "Workspace created", nil)

	s.FailWorkspaceProvisioning(errors.New("docker install failed"))

	if got := runtime.Status; got != "error" {
		t.Fatalf("runtime.Status = %q, want error", got)
	}
	assertWorkspaceEvent(t, s, runtime.ID, "workspace.provisioning_failed")
}

func TestWorkspaceProvisionQueueCoalescesDuplicateWorkspace(t *testing.T) {
	s := newQueueTestServer("http://127.0.0.1")
	runtime := newQueueTestRuntime("WS_DUPLICATE")
	s.workspaces[runtime.ID] = runtime

	s.BlockWorkspaceProvisioning()
	s.startWorkspaceProvision(runtime, "workspace.failed", "Workspace failed", "workspace.created", "Workspace created", map[string]interface{}{"attempt": 1})
	s.startWorkspaceProvision(runtime, "workspace.failed", "Workspace failed", "workspace.created", "Workspace created", map[string]interface{}{"attempt": 2})

	if got := len(s.provisionQueue); got != 1 {
		t.Fatalf("provisionQueue length = %d, want 1", got)
	}
	if got := s.provisionQueue[0].detail["attempt"]; got != 2 {
		t.Fatalf("queued detail attempt = %v, want latest attempt 2", got)
	}
	assertWorkspaceEvent(t, s, runtime.ID, "workspace.queue_coalesced")
}

func TestWorkspaceProvisionQueueRejectsOverflow(t *testing.T) {
	s := newQueueTestServer("http://127.0.0.1")
	s.config.WorkspaceProvisionQueueMax = 1
	first := newQueueTestRuntime("WS_FIRST")
	second := newQueueTestRuntime("WS_SECOND")
	s.workspaces[first.ID] = first
	s.workspaces[second.ID] = second

	s.BlockWorkspaceProvisioning()
	s.startWorkspaceProvision(first, "workspace.provisioning_failed", "Workspace provisioning failed", "workspace.created", "Workspace created", nil)
	s.startWorkspaceProvision(second, "workspace.provisioning_failed", "Workspace provisioning failed", "workspace.created", "Workspace created", nil)

	if got := len(s.provisionQueue); got != 1 {
		t.Fatalf("provisionQueue length = %d, want 1", got)
	}
	if got := first.Status; got != "creating" {
		t.Fatalf("first runtime.Status = %q, want creating", got)
	}
	if got := second.Status; got != "error" {
		t.Fatalf("second runtime.Status = %q, want error", got)
	}
	assertWorkspaceEvent(t, s, second.ID, "workspace.provisioning_failed")
}

func newQueueTestServer(controlPlaneURL string) *Server {
	return &Server{
		config: &config.Config{
			NodeID:                     "NODE_TEST",
			ControlPlaneURL:            controlPlaneURL,
			CallbackToken:              "callback-token",
			ContainerMode:              true,
			WorkspaceDir:               "/workspace",
			DefaultShell:               "/bin/bash",
			DefaultRows:                24,
			DefaultCols:                80,
			ContainerLabelKey:          "devcontainer.local_folder",
			PTYOutputBufferSize:        1024,
			HTTPCallbackTimeout:        time.Second,
			BootstrapTimeout:           5 * time.Second,
			WorkspaceProvisionQueueMax: 20,
		},
		workspaces:          make(map[string]*WorkspaceRuntime),
		nodeEvents:          make([]EventRecord, 0, 16),
		workspaceEvents:     make(map[string][]EventRecord),
		bootLogBroadcasters: NewBootLogBroadcasterManager(),
		provisionReady:      true,
	}
}

func newQueueTestRuntime(workspaceID string) *WorkspaceRuntime {
	return &WorkspaceRuntime{
		ID:                  workspaceID,
		Repository:          "octo/repo",
		Branch:              "main",
		Status:              "creating",
		WorkspaceDir:        "/workspace/" + workspaceID,
		ContainerLabelValue: "/workspace/" + workspaceID,
		ContainerWorkDir:    "/workspaces/repo",
		CallbackToken:       "callback-token",
	}
}

func assertWorkspaceEvent(t *testing.T, s *Server, workspaceID, eventType string) {
	t.Helper()

	s.eventMu.RLock()
	defer s.eventMu.RUnlock()

	for _, event := range s.workspaceEvents[workspaceID] {
		if event.Type == eventType {
			return
		}
	}
	t.Fatalf("event %q not found for workspace %s: %+v", eventType, workspaceID, s.workspaceEvents[workspaceID])
}
