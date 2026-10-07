package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

func TestResourceHistoryFinalFlushCannotRestartWhileStopping(t *testing.T) {
	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	var uploads atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uploads.Add(1)
		entered <- struct{}{}
		<-release
		w.WriteHeader(http.StatusOK)
	}))
	defer api.Close()
	runtime := &WorkspaceRuntime{ID: "workspace-1", ProjectID: "project-1", Status: "running", CallbackToken: "token"}
	s := &Server{config: &config.Config{Role: config.RoleWorkspace, ControlPlaneURL: api.URL,
		ResourceHistorySpoolDir: t.TempDir(), ResourceHistoryUploadTimeout: time.Second},
		workspaces: map[string]*WorkspaceRuntime{runtime.ID: runtime}}
	s.ensureResourceHistoryForRuntime(runtime)
	original := s.resourceHistoryCollector(runtime.ID)
	if original == nil {
		t.Fatal("collector missing")
	}
	original.RecordACPToolCall("tool", "in_progress", "execute", "Bash", time.Now())
	original.RecordACPToolCall("tool", "completed", "execute", "Bash", time.Now())
	done := make(chan struct{})
	go func() { s.stopResourceHistoryForWorkspace(runtime.ID, context.Background()); close(done) }()
	<-entered
	s.resourceHistoryStarted.Store(true)
	s.ensureResourceHistoryForRuntime(runtime)
	if s.resourceHistoryCollector(runtime.ID) != original {
		close(release)
		<-done
		t.Fatal("stopping collector replaced before its final flush completed")
	}
	s.workspaceMu.Lock()
	runtime.Status = "stopped"
	s.workspaceMu.Unlock()
	close(release)
	<-done
	s.ensureResourceHistoryForRuntime(&WorkspaceRuntime{ID: runtime.ID, ProjectID: runtime.ProjectID, Status: "running"})
	if s.resourceHistoryCollector(runtime.ID) != nil {
		t.Fatal("stale runtime restarted stopped collector")
	}
	if uploads.Load() != 1 {
		t.Fatalf("final flush uploaded %d times", uploads.Load())
	}
	// An explicit new running lifecycle can create its next collector.
	s.resourceHistoryStarted.Store(false)
	if _, _, _, err := s.claimWorkspaceReprovision(context.Background(), runtime.ID, workspaceReprovisionRequest{}, []string{"stopped"}); err != nil {
		t.Fatal(err)
	}
	s.ensureResourceHistoryForRuntime(s.snapshotRuntimeForResourceTest(runtime))
	if got := s.resourceHistoryCollector(runtime.ID); got == nil || got == original {
		t.Fatal("explicit restart did not create collector")
	}
}

func (s *Server) snapshotRuntimeForResourceTest(runtime *WorkspaceRuntime) *WorkspaceRuntime {
	snapshot := s.snapshotWorkspaceRuntime(runtime)
	return &snapshot
}
