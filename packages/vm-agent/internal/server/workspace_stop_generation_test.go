package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/pty"
)

func workspaceStopRequest(token, body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/workspaces/ws-restart/stop", strings.NewReader(body))
	r.SetPathValue("workspaceId", "ws-restart")
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("X-SAM-Node-Id", "node-1")
	r.Header.Set("X-SAM-Workspace-Id", "ws-restart")
	return r
}

func TestWorkspaceStopGenerationValidation(t *testing.T) {
	for _, tt := range []struct {
		name, body, generation, status string
		want                           int
	}{
		{"legacy cleanup", "", "", "running", http.StatusOK},
		{"missing generated VM fence", "", restartTestGeneration, "running", http.StatusBadRequest},
		{"matching initial generation", `{"expectedEvictionGeneration":""}`, "", "running", http.StatusOK},
		{"matching generation", `{"expectedEvictionGeneration":"` + restartTestGeneration + `"}`, restartTestGeneration, "running", http.StatusOK},
		{"stale initial generation", `{"expectedEvictionGeneration":""}`, restartTestGeneration, "running", http.StatusConflict},
		{"stale generation", `{"expectedEvictionGeneration":"` + restartTestGeneration + `"}`, restartTestNextGeneration, "running", http.StatusConflict},
		{"evicted remains fenced", `{"expectedEvictionGeneration":"` + restartTestGeneration + `"}`, restartTestGeneration, "evicted", http.StatusConflict},
		{"malformed", "{", "", "running", http.StatusBadRequest},
		{"missing field", "{}", "", "running", http.StatusBadRequest},
		{"null field", `{"expectedEvictionGeneration":null}`, "", "running", http.StatusBadRequest},
		{"non string", `{"expectedEvictionGeneration":12}`, "", "running", http.StatusBadRequest},
		{"unknown field", `{"expectedEvictionGeneration":"","unknown":true}`, "", "running", http.StatusBadRequest},
		{"trailing JSON", `{"expectedEvictionGeneration":""}{}`, "", "running", http.StatusBadRequest},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s, token, finish := newRestartGenerationTestServer(t, tt.status)
			defer finish(errors.New("test complete"))
			s.workspaces["ws-restart"].EvictionGeneration = tt.generation
			rec := httptest.NewRecorder()
			s.handleStopWorkspace(rec, workspaceStopRequest(token, tt.body))
			if rec.Code != tt.want {
				t.Fatalf("stop = %d %s, want %d", rec.Code, rec.Body.String(), tt.want)
			}
			wantStatus := tt.status
			if tt.want == http.StatusOK {
				wantStatus = "stopped"
			}
			if got := s.snapshotWorkspaceRuntime(s.workspaces["ws-restart"]); got.Status != wantStatus || got.EvictionGeneration != tt.generation {
				t.Fatalf("unexpected stop mutation: %#v", got)
			}
		})
	}
}

func TestWorkspaceStopGenerationStandaloneCleanupCompatibility(t *testing.T) {
	s, token, finish := newRestartGenerationTestServer(t, "running")
	defer finish(errors.New("test complete"))
	s.config.Role = config.RoleStandalone
	s.workspaces["ws-restart"].EvictionGeneration = restartTestGeneration
	rec := httptest.NewRecorder()
	s.handleStopWorkspace(rec, workspaceStopRequest(token, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("standalone cleanup stop = %d %s", rec.Code, rec.Body.String())
	}
	if current := s.snapshotWorkspaceRuntime(s.workspaces["ws-restart"]); current.Status != "stopped" || current.EvictionGeneration != restartTestGeneration {
		t.Fatalf("standalone cleanup changed generation or failed to stop: %#v", current)
	}
}

func TestWorkspaceStopGenerationRechecksAfterLifecycleWait(t *testing.T) {
	s, token, finish := newRestartGenerationTestServer(t, "running")
	defer finish(errors.New("test complete"))
	runtime := s.workspaces["ws-restart"]
	runtime.PTY = pty.NewManager(pty.ManagerConfig{DefaultShell: "/bin/sh", DefaultRows: 24, DefaultCols: 80, CloseGrace: time.Millisecond})
	t.Cleanup(runtime.PTY.CloseAllSessions)
	if _, err := runtime.PTY.CreateSession("successor-user", 24, 80); err != nil {
		t.Fatal(err)
	}
	dockerLog := filepath.Join(t.TempDir(), "docker.log")
	dockerCLI := filepath.Join(t.TempDir(), "docker")
	if err := os.WriteFile(dockerCLI, []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SAM_STOP_DOCKER_LOG\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SAM_DOCKER_CLI_PATH", dockerCLI)
	t.Setenv("SAM_STOP_DOCKER_LOG", dockerLog)

	// A lifecycle operation owns this workspace while an old network request
	// arrives with the generation it observed before admission/restart.
	lock := s.workspaceLifecycleLock("ws-restart")
	if err := lock.Lock(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if lock.entry != nil {
			lock.Unlock()
		}
	}()
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.handleStopWorkspace(rec, workspaceStopRequest(token, `{"expectedEvictionGeneration":""}`))
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		s.workspaceLifecycleMu.Lock()
		waiting := s.workspaceLifecycleLocks["ws-restart"].users == 2
		s.workspaceLifecycleMu.Unlock()
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("stop did not wait for lifecycle ownership")
		}
		time.Sleep(time.Millisecond)
	}
	// Complete the durable generation transition while the stale stop waits.
	if changed, err := s.store.CompareAndSwapWorkspaceEvictionGeneration("ws-restart", "", restartTestGeneration); err != nil || !changed {
		t.Fatalf("persist successor generation: %v %v", changed, err)
	}
	s.workspaceMu.Lock()
	runtime.EvictionGeneration = restartTestGeneration
	runtime.UpdatedAt = nowUTC()
	s.workspaceMu.Unlock()
	lock.Unlock()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stop did not finish")
	}
	if rec.Code != http.StatusConflict {
		t.Fatalf("stale stop = %d %s", rec.Code, rec.Body.String())
	}
	if current := s.snapshotWorkspaceRuntime(runtime); current.Status != "running" || current.EvictionGeneration != restartTestGeneration {
		t.Fatalf("stale stop mutated successor: %#v", current)
	}
	if runtime.PTY.SessionCount() != 1 {
		t.Fatal("stale stop closed successor PTY")
	}
	if data, err := os.ReadFile(dockerLog); err == nil && len(data) > 0 {
		t.Fatalf("stale stop ran Docker: %s", data)
	}
}
