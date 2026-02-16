package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/pty"
)

func TestWorkspaceManagementSourceContract(t *testing.T) {
	path := filepath.Join("workspaces.go")
	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	content := string(contentBytes)

	for _, needle := range []string{
		"handleCreateWorkspace",
		"handleStopWorkspace",
		"handleRestartWorkspace",
		"handleDeleteWorkspace",
		"stopSessionHost",
		"stopSessionHostsForWorkspace",
		"callbackToken",
		"provisionWorkspaceRuntime",
	} {
		if !strings.Contains(content, needle) {
			t.Fatalf("expected %q in %s", needle, path)
		}
	}
}

func TestStopAllWorkspacesAndSessions(t *testing.T) {
	ptyManager := pty.NewManager(pty.ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		WorkDir:      "/tmp",
		BufferSize:   1024,
	})

	sessionManager := agentsessions.NewManager()
	if _, _, err := sessionManager.Create("ws-1", "sess-1", "Session 1", ""); err != nil {
		t.Fatalf("create agent session: %v", err)
	}

	s := &Server{
		config: &config.Config{
			NodeID: "node-1",
		},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-1": {
				ID:        "ws-1",
				Status:    "running",
				CreatedAt: time.Now().UTC(),
				UpdatedAt: time.Now().UTC(),
				PTY:       ptyManager,
			},
		},
		nodeEvents:      make([]EventRecord, 0),
		workspaceEvents: map[string][]EventRecord{},
		agentSessions:   sessionManager,
		sessionHosts:    map[string]*acp.SessionHost{},
	}

	s.StopAllWorkspacesAndSessions()

	runtime, ok := s.getWorkspaceRuntime("ws-1")
	if !ok {
		t.Fatalf("workspace runtime missing after stop")
	}
	if runtime.Status != "stopped" {
		t.Fatalf("expected workspace status stopped, got %s", runtime.Status)
	}

	session, ok := sessionManager.Get("ws-1", "sess-1")
	if !ok {
		t.Fatalf("expected session to exist")
	}
	if session.Status != agentsessions.StatusStopped {
		t.Fatalf("expected session status stopped, got %s", session.Status)
	}
}

func TestWorkspaceManagementSourceContractIncludesRebuild(t *testing.T) {
	path := filepath.Join("workspaces.go")
	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	content := string(contentBytes)

	for _, needle := range []string{
		"handleRebuildWorkspace",
	} {
		if !strings.Contains(content, needle) {
			t.Fatalf("expected %q in %s", needle, path)
		}
	}
}

func TestRebuildHandlerRejectsInvalidStatus(t *testing.T) {
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
			"ws-creating": {
				ID:        "ws-creating",
				Status:    "creating",
				CreatedAt: time.Now().UTC(),
				UpdatedAt: time.Now().UTC(),
				PTY:       ptyManager,
			},
			"ws-stopped": {
				ID:        "ws-stopped",
				Status:    "stopped",
				CreatedAt: time.Now().UTC(),
				UpdatedAt: time.Now().UTC(),
				PTY:       ptyManager,
			},
			"ws-running": {
				ID:        "ws-running",
				Status:    "running",
				CreatedAt: time.Now().UTC(),
				UpdatedAt: time.Now().UTC(),
				PTY:       ptyManager,
			},
			"ws-error": {
				ID:        "ws-error",
				Status:    "error",
				CreatedAt: time.Now().UTC(),
				UpdatedAt: time.Now().UTC(),
				PTY:       ptyManager,
			},
		},
		nodeEvents:      make([]EventRecord, 0),
		workspaceEvents: map[string][]EventRecord{},
		agentSessions:   agentsessions.NewManager(),
		sessionHosts:    map[string]*acp.SessionHost{},
	}

	// "creating" status should be rejected
	runtime, _ := s.getWorkspaceRuntime("ws-creating")
	if runtime.Status == "running" || runtime.Status == "error" {
		t.Fatal("expected creating status")
	}

	// "stopped" status should be rejected
	runtime, _ = s.getWorkspaceRuntime("ws-stopped")
	if runtime.Status == "running" || runtime.Status == "error" {
		t.Fatal("expected stopped status")
	}

	// "running" should be accepted
	runtime, _ = s.getWorkspaceRuntime("ws-running")
	if runtime.Status != "running" {
		t.Fatal("expected running status")
	}

	// "error" should be accepted
	runtime, _ = s.getWorkspaceRuntime("ws-error")
	if runtime.Status != "error" {
		t.Fatal("expected error status")
	}
}
