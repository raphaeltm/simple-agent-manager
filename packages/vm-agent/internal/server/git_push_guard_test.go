package server

import (
	"sync"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
)

func TestDefaultBranchForWorkspace(t *testing.T) {
	t.Parallel()

	s := &Server{
		config:     &config.Config{},
		workspaces: map[string]*WorkspaceRuntime{},
	}

	t.Run("returns empty when workspace not found", func(t *testing.T) {
		got := s.defaultBranchForWorkspace("nonexistent")
		if got != "" {
			t.Fatalf("expected empty string for unknown workspace, got %q", got)
		}
	})

	t.Run("returns empty when DefaultBranch is not set", func(t *testing.T) {
		s.workspaceMu.Lock()
		s.workspaces["ws-no-default"] = &WorkspaceRuntime{
			ID:     "ws-no-default",
			Branch: "feature-branch",
		}
		s.workspaceMu.Unlock()

		got := s.defaultBranchForWorkspace("ws-no-default")
		if got != "" {
			t.Fatalf("expected empty string when DefaultBranch not set, got %q", got)
		}
	})

	t.Run("returns DefaultBranch when set", func(t *testing.T) {
		s.workspaceMu.Lock()
		s.workspaces["ws-with-default"] = &WorkspaceRuntime{
			ID:            "ws-with-default",
			Branch:        "feature-branch",
			DefaultBranch: "main",
		}
		s.workspaceMu.Unlock()

		got := s.defaultBranchForWorkspace("ws-with-default")
		if got != "main" {
			t.Fatalf("expected %q, got %q", "main", got)
		}
	})
}

func TestDefaultBranchFlowsThroughUpsertWorkspaceRuntime(t *testing.T) {
	t.Parallel()

	s := &Server{
		config: &config.Config{
			WorkspaceDir: "/workspace",
		},
		workspaces:      map[string]*WorkspaceRuntime{},
		workspaceEvents: map[string][]EventRecord{},
	}

	t.Run("new workspace receives DefaultBranch from opts", func(t *testing.T) {
		runtime := s.upsertWorkspaceRuntime("ws-new", "octo/repo", "feature-branch", "creating", "tok",
			workspaceRuntimeOpts{DefaultBranch: "main"})

		if runtime.DefaultBranch != "main" {
			t.Fatalf("expected DefaultBranch=%q on new runtime, got %q", "main", runtime.DefaultBranch)
		}
	})

	t.Run("existing workspace updates DefaultBranch from opts", func(t *testing.T) {
		// First create without DefaultBranch
		s.upsertWorkspaceRuntime("ws-update", "octo/repo", "feature-branch", "creating", "tok")

		got := s.defaultBranchForWorkspace("ws-update")
		if got != "" {
			t.Fatalf("expected empty DefaultBranch before update, got %q", got)
		}

		// Now upsert with DefaultBranch
		s.upsertWorkspaceRuntime("ws-update", "", "", "running", "",
			workspaceRuntimeOpts{DefaultBranch: "master"})

		got = s.defaultBranchForWorkspace("ws-update")
		if got != "master" {
			t.Fatalf("expected DefaultBranch=%q after update, got %q", "master", got)
		}
	})

	t.Run("empty DefaultBranch in opts does not clear existing", func(t *testing.T) {
		s.upsertWorkspaceRuntime("ws-keep", "octo/repo", "feature-branch", "creating", "tok",
			workspaceRuntimeOpts{DefaultBranch: "main"})

		// Upsert without DefaultBranch — should keep the existing value
		s.upsertWorkspaceRuntime("ws-keep", "", "", "running", "")

		got := s.defaultBranchForWorkspace("ws-keep")
		if got != "main" {
			t.Fatalf("expected DefaultBranch=%q to be preserved, got %q", "main", got)
		}
	})
}

func TestDefaultBranchForWorkspace_ConcurrentAccess(t *testing.T) {
	t.Parallel()

	s := &Server{
		config:     &config.Config{},
		workspaces: map[string]*WorkspaceRuntime{},
	}

	s.workspaceMu.Lock()
	s.workspaces["ws-race"] = &WorkspaceRuntime{
		ID:            "ws-race",
		DefaultBranch: "main",
	}
	s.workspaceMu.Unlock()

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got := s.defaultBranchForWorkspace("ws-race")
			if got != "main" {
				t.Errorf("expected %q under concurrent reads, got %q", "main", got)
			}
		}()
	}
	wg.Wait()
}

func TestCreateWorkspaceRequestDefaultBranch(t *testing.T) {
	t.Parallel()

	t.Run("DefaultBranch is trimmed from request", func(t *testing.T) {
		body := createWorkspaceRequest{
			DefaultBranch: "  main  ",
		}
		opts := createWorkspaceRuntimeOptions(body, "")
		if opts.DefaultBranch != "main" {
			t.Fatalf("expected trimmed DefaultBranch=%q, got %q", "main", opts.DefaultBranch)
		}
	})

	t.Run("empty DefaultBranch yields empty opts", func(t *testing.T) {
		body := createWorkspaceRequest{}
		opts := createWorkspaceRuntimeOptions(body, "")
		if opts.DefaultBranch != "" {
			t.Fatalf("expected empty DefaultBranch, got %q", opts.DefaultBranch)
		}
	})
}
