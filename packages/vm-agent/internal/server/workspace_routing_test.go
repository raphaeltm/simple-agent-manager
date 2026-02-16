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

func TestWorkspaceDirForRepo(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		workspaceID string
		repository  string
		configWsID  string
		configWsDir string
		want        string
	}{
		{
			name:        "uses repo name from HTTPS URL",
			workspaceID: "WS_ABC",
			repository:  "https://github.com/octo/my-cool-repo",
			configWsDir: "/workspace",
			want:        "/workspace/my-cool-repo",
		},
		{
			name:        "uses repo name from short form",
			workspaceID: "WS_ABC",
			repository:  "octo/hello-world",
			configWsDir: "/workspace",
			want:        "/workspace/hello-world",
		},
		{
			name:        "strips .git suffix",
			workspaceID: "WS_ABC",
			repository:  "https://github.com/owner/repo.git",
			configWsDir: "/workspace",
			want:        "/workspace/repo",
		},
		{
			name:        "falls back to workspace ID when no repository",
			workspaceID: "WS_ABC",
			repository:  "",
			configWsDir: "/workspace",
			want:        "/workspace/WS_ABC",
		},
		{
			name:        "returns base dir for legacy single-workspace match",
			workspaceID: "WS_LEGACY",
			repository:  "octo/repo",
			configWsID:  "WS_LEGACY",
			configWsDir: "/workspace",
			want:        "/workspace",
		},
		{
			name:        "sanitizes special characters in repo name",
			workspaceID: "WS_ABC",
			repository:  "owner/my repo@special!",
			configWsDir: "/workspace",
			want:        "/workspace/my-repo-special",
		},
		{
			name:        "defaults base dir to /workspace when config empty",
			workspaceID: "WS_ABC",
			repository:  "octo/test-repo",
			configWsDir: "",
			want:        "/workspace/test-repo",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			s := &Server{
				config: &config.Config{
					WorkspaceID:  tt.configWsID,
					WorkspaceDir: tt.configWsDir,
				},
				workspaces: map[string]*WorkspaceRuntime{},
			}
			got := s.workspaceDirForRepo(tt.workspaceID, tt.repository)
			if got != tt.want {
				t.Errorf("workspaceDirForRepo(%q, %q) = %q, want %q",
					tt.workspaceID, tt.repository, got, tt.want)
			}
		})
	}
}

func TestCasWorkspaceStatus(t *testing.T) {
	t.Parallel()

	ptyManager := pty.NewManager(pty.ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		WorkDir:      "/tmp",
		BufferSize:   1024,
	})

	s := &Server{
		config: &config.Config{
			NodeID: "node-1",
		},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-running": {
				ID:     "ws-running",
				Status: "running",
				PTY:    ptyManager,
			},
			"ws-creating": {
				ID:     "ws-creating",
				Status: "creating",
				PTY:    ptyManager,
			},
			"ws-stopped": {
				ID:     "ws-stopped",
				Status: "stopped",
				PTY:    ptyManager,
			},
		},
		nodeEvents:      make([]EventRecord, 0),
		workspaceEvents: map[string][]EventRecord{},
	}

	// Transition running -> stopped should succeed
	if !s.casWorkspaceStatus("ws-running", []string{"running", "creating"}, "stopped") {
		t.Fatal("expected CAS from running to stopped to succeed")
	}
	runtime, _ := s.getWorkspaceRuntime("ws-running")
	if runtime.Status != "stopped" {
		t.Fatalf("expected stopped, got %s", runtime.Status)
	}

	// Transition stopped -> stopped should fail (stopped is not in expected list)
	if s.casWorkspaceStatus("ws-running", []string{"running"}, "error") {
		t.Fatal("expected CAS from stopped (already transitioned) to fail")
	}

	// Transition creating -> running should succeed
	if !s.casWorkspaceStatus("ws-creating", []string{"creating"}, "running") {
		t.Fatal("expected CAS from creating to running to succeed")
	}
	runtime, _ = s.getWorkspaceRuntime("ws-creating")
	if runtime.Status != "running" {
		t.Fatalf("expected running, got %s", runtime.Status)
	}

	// Non-existent workspace should return false
	if s.casWorkspaceStatus("ws-nonexistent", []string{"running"}, "stopped") {
		t.Fatal("expected CAS on nonexistent workspace to fail")
	}
}

func TestAppendNodeEventRespectsConfigLimits(t *testing.T) {
	t.Parallel()

	s := &Server{
		config: &config.Config{
			NodeID:             "node-1",
			MaxNodeEvents:      3,
			MaxWorkspaceEvents: 2,
		},
		workspaces:      map[string]*WorkspaceRuntime{},
		nodeEvents:      make([]EventRecord, 0),
		workspaceEvents: map[string][]EventRecord{},
	}

	// Append 5 node events, only 3 should remain
	for i := 0; i < 5; i++ {
		s.appendNodeEvent("ws-1", "info", "test.event", "test message", nil)
	}

	s.eventMu.RLock()
	nodeLen := len(s.nodeEvents)
	wsLen := len(s.workspaceEvents["ws-1"])
	s.eventMu.RUnlock()

	if nodeLen != 3 {
		t.Fatalf("expected 3 node events, got %d", nodeLen)
	}
	if wsLen != 2 {
		t.Fatalf("expected 2 workspace events, got %d", wsLen)
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
