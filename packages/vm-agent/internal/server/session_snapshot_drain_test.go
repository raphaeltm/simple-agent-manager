package server

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/config"
)

func TestDrainStandaloneSnapshotNoopWithoutStandaloneConfig(t *testing.T) {
	s := &Server{}
	if err := s.DrainStandaloneSnapshot(context.Background()); err != nil {
		t.Fatalf("DrainStandaloneSnapshot() error = %v", err)
	}
}

func TestDrainStandaloneSnapshotSharesOneConcurrentAttempt(t *testing.T) {
	wantErr := errors.New("checkpoint degraded")
	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	s := &Server{
		drainSnapshotFn: func(context.Context) error {
			if calls.Add(1) == 1 {
				close(started)
			}
			<-release
			return wantErr
		},
	}

	const callers = 8
	errs := make(chan error, callers)
	var wg sync.WaitGroup
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- s.DrainStandaloneSnapshot(context.Background())
		}()
	}
	<-started
	close(release)
	wg.Wait()
	close(errs)

	if got := calls.Load(); got != 1 {
		t.Fatalf("checkpoint calls = %d, want 1", got)
	}
	for err := range errs {
		if !errors.Is(err, wantErr) {
			t.Fatalf("shared error = %v, want %v", err, wantErr)
		}
	}
}

func newStandaloneDrainTestServer(callbackToken string, sessionIDs ...string) *Server {
	const workspaceID = "ws-drain"
	manager := agentsessions.NewManager()
	for _, sessionID := range sessionIDs {
		_, _, _ = manager.Create(workspaceID, sessionID, "", "")
	}
	return &Server{
		config:        &config.Config{Role: config.RoleStandalone, WorkspaceID: workspaceID, ChatSessionID: "chat-1"},
		workspaces:    map[string]*WorkspaceRuntime{workspaceID: {ID: workspaceID, CallbackToken: callbackToken}},
		agentSessions: manager,
	}
}

func TestDrainStandaloneSnapshotUsesExactSingleSessionAndCallerDeadline(t *testing.T) {
	s := newStandaloneDrainTestServer("workspace-token", "agent-active")
	deadline := time.Now().Add(time.Second)
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	var called int
	s.hibernateSnapshotFn = func(gotCtx context.Context, runtime *WorkspaceRuntime, sessionID, chatSessionID, runtimeName, token string) (map[string]interface{}, error) {
		called++
		gotDeadline, ok := gotCtx.Deadline()
		if !ok || !gotDeadline.Equal(deadline) {
			t.Fatalf("checkpoint deadline = %v, want %v", gotDeadline, deadline)
		}
		if runtime.ID != "ws-drain" || sessionID != "agent-active" || chatSessionID != "chat-1" || runtimeName != "cf-container" || token != "workspace-token" {
			t.Fatalf("checkpoint args = runtime %q session %q chat %q mode %q token %q", runtime.ID, sessionID, chatSessionID, runtimeName, token)
		}
		return map[string]interface{}{"status": "available"}, nil
	}
	if err := s.DrainStandaloneSnapshot(ctx); err != nil {
		t.Fatalf("DrainStandaloneSnapshot() error = %v", err)
	}
	if called != 1 {
		t.Fatalf("checkpoint calls = %d, want 1", called)
	}
}

func TestDrainStandaloneSnapshotRejectsAmbiguousSessions(t *testing.T) {
	s := newStandaloneDrainTestServer("workspace-token", "agent-a", "agent-b")
	s.hibernateSnapshotFn = func(context.Context, *WorkspaceRuntime, string, string, string, string) (map[string]interface{}, error) {
		t.Fatal("ambiguous drain must not guess a session")
		return nil, nil
	}
	err := s.DrainStandaloneSnapshot(context.Background())
	if err == nil || !strings.Contains(err.Error(), "exactly one agent session") {
		t.Fatalf("DrainStandaloneSnapshot() error = %v", err)
	}
}

func TestDrainStandaloneSnapshotDegradesWithoutCallbackToken(t *testing.T) {
	s := newStandaloneDrainTestServer("", "agent-active")
	err := s.DrainStandaloneSnapshot(context.Background())
	if err == nil || !strings.Contains(err.Error(), "callback token unavailable") {
		t.Fatalf("DrainStandaloneSnapshot() error = %v", err)
	}
}
