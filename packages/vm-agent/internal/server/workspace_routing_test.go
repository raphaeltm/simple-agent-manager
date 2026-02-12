package server

import (
	"reflect"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/pty"
)

func TestContainerLabelCandidates(t *testing.T) {
	t.Parallel()

	got := containerLabelCandidates(
		" /workspace/ws-123 ",
		"",
		"/workspace/ws-123",
		"/workspace/legacy-repo",
		"/workspace",
		"/workspace",
	)

	want := []string{
		"/workspace/ws-123",
		"/workspace/legacy-repo",
		"/workspace",
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("containerLabelCandidates() = %#v, want %#v", got, want)
	}
}

func TestShouldReusePrimaryPTYManager(t *testing.T) {
	t.Parallel()

	legacyManager := pty.NewManager(pty.ManagerConfig{
		DefaultShell: "/bin/bash",
		DefaultRows:  24,
		DefaultCols:  80,
	})

	s := &Server{
		config: &config.Config{
			ContainerMode:       true,
			WorkspaceID:         "WS_LEGACY",
			WorkspaceDir:        "/workspace",
			ContainerWorkDir:    "/workspaces",
			ContainerLabelValue: "/workspace",
		},
		ptyManager: legacyManager,
		workspaces: map[string]*WorkspaceRuntime{},
	}

	if !s.shouldReusePrimaryPTYManager("WS_LEGACY", "/workspace", "/workspaces", "/workspace") {
		t.Fatal("expected primary PTY manager reuse for exact legacy runtime match")
	}

	if s.shouldReusePrimaryPTYManager(
		"WS_LEGACY",
		"/workspace/repo-one",
		"/workspaces/repo-one",
		"/workspace/repo-one",
	) {
		t.Fatal("expected no reuse when runtime paths diverge from legacy config")
	}

	if s.shouldReusePrimaryPTYManager("WS_OTHER", "/workspace/WS_OTHER", "/workspaces/WS_OTHER", "/workspace/WS_OTHER") {
		t.Fatal("expected no reuse for non-legacy workspace IDs")
	}
}

func TestNewPTYManagerForWorkspaceSkipsLegacyReuseAfterRuntimeUpdate(t *testing.T) {
	t.Parallel()

	legacyManager := pty.NewManager(pty.ManagerConfig{
		DefaultShell: "/bin/bash",
		DefaultRows:  24,
		DefaultCols:  80,
	})

	s := &Server{
		config: &config.Config{
			ContainerMode:       true,
			WorkspaceID:         "WS_LEGACY",
			WorkspaceDir:        "/workspace",
			ContainerWorkDir:    "/workspaces",
			ContainerLabelValue: "/workspace",
			ContainerLabelKey:   "devcontainer.local_folder",
		},
		ptyManager: legacyManager,
		workspaces: map[string]*WorkspaceRuntime{},
	}

	migratedManager := s.newPTYManagerForWorkspace(
		"WS_LEGACY",
		"/workspace/repo-one",
		"/workspaces/repo-one",
		"/workspace/repo-one",
	)
	if migratedManager == legacyManager {
		t.Fatal("expected migrated runtime to receive a workspace-specific PTY manager")
	}
}
