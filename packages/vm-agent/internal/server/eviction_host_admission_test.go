package server

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/agentsessions"
)

func TestEvictionStopRejectsLateSessionHosts(t *testing.T) {
	for _, retry := range []bool{false, true} {
		name := "initial"
		if retry {
			name = "retry"
		}
		t.Run(name, func(t *testing.T) {
			s := newEvictionTestServer()
			initializeEvictionTestStore(t, s)
			setupEvictionDocker(t, evictionTestContainerID)
			dir := t.TempDir()
			started, release := filepath.Join(dir, "started"), filepath.Join(dir, "release")
			t.Setenv("SAM_EVICTION_TEST_STOP_STARTED", started)
			t.Setenv("SAM_EVICTION_TEST_STOP_RELEASE", release)
			t.Setenv("SAM_EVICTION_TEST_STOP_EXIT", "1")
			t.Cleanup(func() { _ = os.WriteFile(release, nil, 0600) })
			done := make(chan error, 1)
			if retry {
				delivery := queueEvictionFixture(t, s, false)
				go func() { _, err := s.reconcilePendingEvictionStop(context.Background(), &delivery); done <- err }()
			} else {
				go func() { done <- s.stopEvictedWorkspaceContainer(context.Background(), evictionTargetFixture(s)) }()
			}
			deadline := time.Now().Add(2 * time.Second)
			for {
				if _, err := os.Stat(started); err == nil {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("Docker stop was not reached")
				}
				time.Sleep(5 * time.Millisecond)
			}
			for _, restoreOwner := range []bool{false, true} {
				if host := s.getOrCreateSessionHostForRestore("workspace-1:late", "workspace-1", "late", agentsessions.Session{}, nil, "", restoreOwner); host != nil {
					t.Error("new host admitted after eviction collected its hosts")
				}
			}
			if err := os.WriteFile(release, nil, 0600); err != nil {
				t.Fatal(err)
			}
			if err := <-done; err == nil {
				t.Fatal("expected failed Docker stop")
			}
			if s.isEvictionFinalizing("workspace-1") {
				t.Fatal("failed stop left admission closed")
			}
			if host := s.getOrCreateSessionHost("workspace-1:after", "workspace-1", "after", agentsessions.Session{}, nil, ""); host == nil {
				t.Fatal("failed stop did not reopen host admission")
			}
		})
	}
}
