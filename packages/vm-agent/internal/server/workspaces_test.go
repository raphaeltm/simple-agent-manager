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
		"closeAgentGateway",
		"closeAgentGatewaysForWorkspace",
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
		acpGateways:     map[string]*acp.Gateway{},
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
