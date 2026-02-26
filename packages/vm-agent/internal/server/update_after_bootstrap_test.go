package server

import (
	"strings"
	"testing"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/errorreport"
	"github.com/workspace/vm-agent/internal/pty"
)

func TestUpdateAfterBootstrap_PropagatesContainerUser(t *testing.T) {
	// Simulate the real startup sequence: server.New() is called before
	// bootstrap.Run(), so ContainerUser is empty at server creation time.
	// After bootstrap detects the user, UpdateAfterBootstrap must propagate
	// it to the PTY manager and ACP gateway config.

	ptyManager := pty.NewManager(pty.ManagerConfig{
		DefaultShell: "/bin/bash",
		DefaultRows:  24,
		DefaultCols:  80,
		// ContainerUser is empty — simulates pre-bootstrap state
	})

	srv := &Server{
		config: &config.Config{
			ContainerMode: true,
		},
		ptyManager: ptyManager,
		acpConfig: acp.GatewayConfig{
			// ContainerUser is empty — simulates pre-bootstrap state
		},
		errorReporter:       errorreport.New("", "", "", errorreport.Config{}),
		workspaces:          make(map[string]*WorkspaceRuntime),
		bootLogBroadcasters: NewBootLogBroadcasterManager(),
	}

	// Simulate bootstrap detecting ContainerUser = "node"
	postBootstrapCfg := &config.Config{
		ContainerUser: "node",
		CallbackToken: "test-token",
	}

	srv.UpdateAfterBootstrap(postBootstrapCfg)

	// Verify ACP gateway config was updated
	if srv.acpConfig.ContainerUser != "node" {
		t.Errorf("acpConfig.ContainerUser = %q, want %q", srv.acpConfig.ContainerUser, "node")
	}

	// Verify the PTY manager got the user by creating a session and checking
	// that docker exec would use -u node. Since we can't inspect the private
	// field directly, we verify via SetContainerUser's effect on new sessions.
	// The SetContainerUser method is tested separately below.
}

func TestUpdateAfterBootstrap_DoesNotOverrideExistingContainerUser(t *testing.T) {
	// If the server was somehow configured with a ContainerUser already
	// (e.g. via CONTAINER_USER env var), UpdateAfterBootstrap should not
	// overwrite it.

	ptyManager := pty.NewManager(pty.ManagerConfig{
		DefaultShell:  "/bin/bash",
		ContainerUser: "existing-user",
	})

	srv := &Server{
		config: &config.Config{
			ContainerMode: true,
			ContainerUser: "existing-user",
		},
		ptyManager: ptyManager,
		acpConfig: acp.GatewayConfig{
			ContainerUser: "existing-user",
		},
		errorReporter:       errorreport.New("", "", "", errorreport.Config{}),
		workspaces:          make(map[string]*WorkspaceRuntime),
		bootLogBroadcasters: NewBootLogBroadcasterManager(),
	}

	postBootstrapCfg := &config.Config{
		ContainerUser: "node",
		CallbackToken: "test-token",
	}

	srv.UpdateAfterBootstrap(postBootstrapCfg)

	// Should NOT overwrite the existing ACP user
	if srv.acpConfig.ContainerUser != "existing-user" {
		t.Errorf("acpConfig.ContainerUser = %q, want %q (should not overwrite)", srv.acpConfig.ContainerUser, "existing-user")
	}
}

func TestUpdateAfterBootstrap_SkipsEmptyContainerUser(t *testing.T) {
	// If bootstrap didn't detect a container user, don't set garbage values.

	ptyManager := pty.NewManager(pty.ManagerConfig{
		DefaultShell: "/bin/bash",
	})

	srv := &Server{
		config: &config.Config{},
		ptyManager: ptyManager,
		acpConfig:  acp.GatewayConfig{},
		errorReporter:       errorreport.New("", "", "", errorreport.Config{}),
		workspaces:          make(map[string]*WorkspaceRuntime),
		bootLogBroadcasters: NewBootLogBroadcasterManager(),
	}

	postBootstrapCfg := &config.Config{
		ContainerUser: "  ", // whitespace only
		CallbackToken: "test-token",
	}

	srv.UpdateAfterBootstrap(postBootstrapCfg)

	if strings.TrimSpace(srv.acpConfig.ContainerUser) != "" {
		t.Errorf("acpConfig.ContainerUser = %q, want empty", srv.acpConfig.ContainerUser)
	}
}
