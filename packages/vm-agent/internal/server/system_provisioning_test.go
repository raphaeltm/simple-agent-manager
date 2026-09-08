package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/config"
)

func TestCreateWorkspaceWaitsForSystemProvisioningBeforeBuild(t *testing.T) {
	original := prepareWorkspaceForRuntime
	defer func() { prepareWorkspaceForRuntime = original }()
	var dockerRestartCompleted atomic.Bool
	builds := make(chan bool, 1)
	prepareWorkspaceForRuntime = func(context.Context, *config.Config, bootstrap.ProvisionState, *bootlog.Reporter) (bool, error) {
		builds <- dockerRestartCompleted.Load()
		return false, nil
	}
	controlPlane := newWorkspaceCreateControlPlane(t)
	validator, privateKey := newWorkspaceCreateJWTValidator(t, "node-1")
	s := newWorkspaceCreateServer(t, controlPlane.URL, validator)
	s.buildQueue = make(chan struct{}, 1)
	s.config.SystemProvisioningTimeout = time.Second
	finish := s.BeginSystemProvisioning()
	defer func() { finish(nil); waitForProvisioningInactive(t, s, "ws-startup") }()

	health := httptest.NewRecorder()
	s.handleHealth(health, httptest.NewRequest(http.MethodGet, "/health", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("startup liveness status = %d", health.Code)
	}
	token := signWorkspaceCreateNodeToken(t, privateKey, "node-1", "ws-startup")
	if response := postCreateWorkspace(t, s, token, "ws-startup"); response.Code != http.StatusAccepted {
		t.Fatalf("create during host setup = %d, want accepted", response.Code)
	}
	select {
	case <-builds:
		t.Fatal("workspace build started before host setup and Docker restart completed")
	case <-time.After(50 * time.Millisecond):
	}
	dockerRestartCompleted.Store(true)
	finish(nil)
	select {
	case afterRestart := <-builds:
		if !afterRestart {
			t.Fatal("workspace build raced Docker restart")
		}
	case <-time.After(time.Second):
		t.Fatal("first workspace remained blocked after system provisioning completed")
	}
	waitForProvisioningInactive(t, s, "ws-startup")
	runtime, _ := s.getWorkspaceRuntime("ws-startup")
	if runtime.Status != "running" {
		t.Fatalf("workspace status = %s", runtime.Status)
	}
}

func TestCreateWorkspaceFailsWithoutBuildingWhenSystemProvisioningCannotFinish(t *testing.T) {
	for _, mode := range []string{"failed", "timeout", "shutdown"} {
		t.Run(mode, func(t *testing.T) {
			original := prepareWorkspaceForRuntime
			defer func() { prepareWorkspaceForRuntime = original }()
			var builds atomic.Int32
			prepareWorkspaceForRuntime = func(context.Context, *config.Config, bootstrap.ProvisionState, *bootlog.Reporter) (bool, error) {
				builds.Add(1)
				return false, nil
			}
			failures := make(chan string, 1)
			controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/workspaces/ws-startup-failed/provisioning-failed" {
					t.Errorf("unexpected request before system provisioning: %s", r.URL.Path)
				}
				var payload map[string]string
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Errorf("decode failure callback: %v", err)
				}
				failures <- payload["errorMessage"]
				w.WriteHeader(http.StatusOK)
			}))
			defer controlPlane.Close()
			validator, privateKey := newWorkspaceCreateJWTValidator(t, "node-1")
			s := newWorkspaceCreateServer(t, controlPlane.URL, validator)
			s.done = make(chan struct{})
			s.sysInfoCollector = stubCollector(0, 10, 10)
			s.config.SystemProvisioningTimeout = 10 * time.Millisecond
			finish := s.BeginSystemProvisioning()
			defer finish(nil)
			if mode == "failed" {
				finish(errors.New("Docker setup failed"))
			}
			if mode == "shutdown" {
				close(s.done)
			}
			token := signWorkspaceCreateNodeToken(t, privateKey, "node-1", "ws-startup-failed")
			if response := postCreateWorkspace(t, s, token, "ws-startup-failed"); response.Code != http.StatusAccepted {
				t.Fatalf("create = %d, want accepted", response.Code)
			}
			waitForProvisioningInactive(t, s, "ws-startup-failed")
			runtime, _ := s.getWorkspaceRuntime("ws-startup-failed")
			if runtime.Status != "error" || builds.Load() != 0 {
				t.Fatalf("status = %s, builds = %d; want error without Docker work", runtime.Status, builds.Load())
			}
			select {
			case message := <-failures:
				if message == "" {
					t.Fatal("missing failure diagnostic")
				}
			default:
				t.Fatal("system provisioning failure was not published to the control plane")
			}
		})
	}
}

func TestSystemProvisioningWaitHonorsCallerCancellation(t *testing.T) {
	s := &Server{config: &config.Config{ContainerMode: true, SystemProvisioningTimeout: time.Second}}
	finish := s.BeginSystemProvisioning()
	defer finish(nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.provisionWorkspaceRuntime(ctx, &WorkspaceRuntime{ID: "ws-canceled"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("provision cancellation = %v", err)
	}
	if err := s.recoverWorkspaceRuntime(ctx, &WorkspaceRuntime{ID: "ws-canceled"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("recovery cancellation = %v", err)
	}
}
