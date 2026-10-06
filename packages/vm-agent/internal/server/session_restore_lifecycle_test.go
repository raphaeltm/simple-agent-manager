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
	"sync/atomic"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/pty"
)

func awaitRestoreLifecycleSignal(t *testing.T, signal <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatal(message)
	}
}

func waitForRestoreLifecycleState(t *testing.T, ready func() bool, message string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !ready() {
		if time.Now().After(deadline) {
			t.Fatal(message)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestSessionRestorePanicSettlesAndCachesFailure(t *testing.T) {
	s, input := newRestoreRetryTestServer(t)
	s.workspaces["ws"].Status = "running"
	var calls atomic.Int32
	const panicSecret = "restore-panic-secret-canary"
	for range 2 {
		result, err := s.runSessionRestore(t.Context(), input, func(context.Context) map[string]interface{} {
			calls.Add(1)
			panic(panicSecret)
		})
		if err == nil || result != nil {
			t.Fatalf("panicked restore returned success: result=%v err=%v", result, err)
		}
		if strings.Contains(err.Error(), panicSecret) {
			t.Fatal("panic details escaped in the cached error")
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("retry replayed a panicked restore: calls=%d", calls.Load())
	}
}

func TestSessionRestoreRevalidatesWorkspaceAfterLifecycleWait(t *testing.T) {
	for _, change := range []string{"deleted", "replaced", "stopped"} {
		t.Run(change, func(t *testing.T) {
			s, input := newRestoreRetryTestServer(t)
			s.workspaces["ws"].Status = "running"
			lock := s.workspaceLifecycleLock("ws")
			if err := lock.Lock(t.Context()); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if lock.entry != nil {
					lock.Unlock()
				}
			}()
			var effects atomic.Int32
			finished := make(chan struct{})
			var restoreErr error
			go func() {
				defer close(finished)
				_, restoreErr = s.runSessionRestore(t.Context(), input, func(context.Context) map[string]interface{} {
					effects.Add(1)
					return map[string]interface{}{"status": "restored"}
				})
			}()
			waitForRestoreLifecycleState(t, func() bool {
				s.sessionHostMu.Lock()
				defer s.sessionHostMu.Unlock()
				return s.sessionRestores["ws:session"] != nil
			}, "restore was never admitted")
			s.workspaceMu.Lock()
			switch change {
			case "deleted":
				delete(s.workspaces, "ws")
			case "replaced":
				s.workspaces["ws"] = &WorkspaceRuntime{ID: "ws", ProjectID: "project", Status: "running", CallbackToken: "successor"}
			case "stopped":
				s.workspaces["ws"].Status = "stopped"
			}
			s.workspaceMu.Unlock()
			lock.Unlock()
			awaitRestoreLifecycleSignal(t, finished, "restore did not reject its stale runtime")
			if restoreErr == nil || effects.Load() != 0 {
				t.Fatalf("stale runtime reached restore effects: err=%v effects=%d", restoreErr, effects.Load())
			}
			if current, exists := s.getWorkspaceRuntime("ws"); exists && current.CallbackToken == "fresh" {
				t.Fatal("stale restore replaced callback credentials")
			}
			if tabs, err := s.store.ListTabs("ws"); err != nil || len(tabs) != 0 {
				t.Fatalf("stale restore persisted a session fence: tabs=%v err=%v", tabs, err)
			}
		})
	}
}

// Exercise real authenticated handlers and the control-plane HTTP boundary:
// deleting a workspace must wait until its detached restore has stopped writing.
func TestSessionRestoreSerializesWorkspaceDeleteAfterCallerDisconnect(t *testing.T) {
	fetchStarted, releaseFetch := make(chan struct{}), make(chan struct{})
	s, request := newStandaloneRestoreHandlerServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet {
			close(fetchStarted)
			select {
			case <-releaseFetch:
			case <-r.Context().Done():
				return
			}
			_, _ = w.Write([]byte(`{"available":false,"reason":"No saved snapshot"}`))
			return
		}
		_, _ = w.Write([]byte(`{}`))
	})
	s.workspaces["ws"].Status = "running"
	s.workspaces["ws"].PTY = pty.NewManager(pty.ManagerConfig{})
	// Stub only the external Docker executable used by the real delete handler.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	requestCtx, cancel := context.WithCancel(t.Context())
	defer cancel()
	requestDone := make(chan struct{})
	go func() {
		defer close(requestDone)
		s.handleRestoreAgentSession(httptest.NewRecorder(), request(requestCtx))
	}()
	awaitRestoreLifecycleSignal(t, fetchStarted, "restore did not reach control plane")
	cancel()
	awaitRestoreLifecycleSignal(t, requestDone, "disconnected caller kept waiting")
	defer func() {
		select {
		case <-releaseFetch:
		default:
			close(releaseFetch)
		}
	}()
	deleteDone := make(chan struct{})
	response := httptest.NewRecorder()
	go func() {
		defer close(deleteDone)
		r := request(t.Context())
		r.Method = http.MethodDelete
		s.handleDeleteWorkspace(response, r)
	}()
	waitForRestoreLifecycleState(t, func() bool {
		s.workspaceLifecycleMu.Lock()
		defer s.workspaceLifecycleMu.Unlock()
		entry := s.workspaceLifecycleLocks["ws"]
		return entry != nil && entry.users == 2
	}, "delete did not wait for the accepted restore")
	if _, exists := s.getWorkspaceRuntime("ws"); !exists {
		t.Fatal("delete removed the workspace while restore was still running")
	}
	close(releaseFetch)
	awaitRestoreLifecycleSignal(t, deleteDone, "delete did not finish after restore settled")
	if response.Code != http.StatusOK {
		t.Fatalf("delete returned %d: %s", response.Code, response.Body.String())
	}
	if _, exists := s.getWorkspaceRuntime("ws"); exists || len(s.agentSessions.List("ws")) != 0 {
		t.Fatal("restore resurrected the deleted workspace or session")
	}
}

func TestSessionRestoreServerStopCancelsAndJoinsBeforeStoreClose(t *testing.T) {
	s, input := newRestoreRetryTestServer(t)
	lifecycle := newShutdownTestServer(t)
	s.sessionManager, s.jwtValidator = lifecycle.sessionManager, lifecycle.jwtValidator
	s.errorReporter, s.httpServer, s.done = lifecycle.errorReporter, lifecycle.httpServer, lifecycle.done
	s.workspaces["ws"].Status = "running"
	s.workspaces["ws"].PTY = pty.NewManager(pty.ManagerConfig{})
	started, cancelled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	releaseRestore := func() { releaseOnce.Do(func() { close(release) }) }
	restoreDone := make(chan struct{})
	go func() {
		defer close(restoreDone)
		_, _ = s.runSessionRestore(t.Context(), input, func(ctx context.Context) map[string]interface{} {
			close(started)
			<-ctx.Done()
			close(cancelled)
			<-release
			if _, err := s.store.ListTabs("ws"); err != nil {
				t.Errorf("shutdown closed persistence before restore settled: %v", err)
			}
			return map[string]interface{}{"status": "degraded"}
		})
	}()
	awaitRestoreLifecycleSignal(t, started, "restore did not start")
	stopDone := make(chan struct{})
	go func() {
		defer close(stopDone)
		if err := s.Stop(context.Background()); err != nil {
			t.Errorf("Stop failed: %v", err)
		}
	}()
	defer releaseRestore()
	awaitRestoreLifecycleSignal(t, cancelled, "server shutdown did not cancel its restore")
	select {
	case <-stopDone:
		t.Fatal("shutdown returned before restore released its resources")
	default:
	}
	// The closing server must reject a new attempt even though the workspace's
	// routed identity is otherwise still valid.
	retryCtx, cancelRetry := context.WithTimeout(t.Context(), time.Second)
	defer cancelRetry()
	if _, err := s.runSessionRestore(retryCtx, input, func(context.Context) map[string]interface{} {
		t.Error("closing server admitted restore effects")
		return nil
	}); err == nil {
		t.Fatal("closing server accepted a restore")
	} else if errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("closing server joined a restore instead of refusing admission")
	}
	releaseRestore()
	awaitRestoreLifecycleSignal(t, restoreDone, "restore did not settle after cancellation")
	awaitRestoreLifecycleSignal(t, stopDone, "shutdown did not finish after restore settled")
}
