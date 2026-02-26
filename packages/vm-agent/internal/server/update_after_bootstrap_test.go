package server

import (
	"strings"
	"testing"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/errorreport"
	"github.com/workspace/vm-agent/internal/pty"
)

// newTestServerPreBootstrap creates a Server in the state it would be in
// right after server.New() but BEFORE bootstrap.Run() completes — i.e.
// ContainerUser is empty everywhere. This mirrors the real startup sequence
// introduced in 6f08afe where the server starts before bootstrap for
// /health availability.
func newTestServerPreBootstrap(t *testing.T, containerResolver pty.ContainerResolver) *Server {
	t.Helper()

	ptyManager := pty.NewManager(pty.ManagerConfig{
		DefaultShell:      "/bin/sh",
		DefaultRows:       24,
		DefaultCols:       80,
		ContainerResolver: containerResolver,
		// ContainerUser is intentionally empty — pre-bootstrap state
	})

	return &Server{
		config: &config.Config{
			ContainerMode: true,
			// ContainerUser is intentionally empty — pre-bootstrap state
		},
		ptyManager: ptyManager,
		acpConfig: acp.GatewayConfig{
			ContainerResolver: containerResolver,
			// ContainerUser is intentionally empty — pre-bootstrap state
		},
		errorReporter:       errorreport.New("", "", "", errorreport.Config{}),
		workspaces:          make(map[string]*WorkspaceRuntime),
		bootLogBroadcasters: NewBootLogBroadcasterManager(),
	}
}

func TestUpdateAfterBootstrap_PropagatesContainerUser(t *testing.T) {
	srv := newTestServerPreBootstrap(t, nil)

	// Simulate bootstrap detecting ContainerUser = "node"
	postBootstrapCfg := &config.Config{
		ContainerUser: "node",
		CallbackToken: "test-token",
	}

	srv.UpdateAfterBootstrap(postBootstrapCfg)

	// Verify all three propagation targets
	if srv.config.ContainerUser != "node" {
		t.Errorf("config.ContainerUser = %q, want %q", srv.config.ContainerUser, "node")
	}
	if srv.acpConfig.ContainerUser != "node" {
		t.Errorf("acpConfig.ContainerUser = %q, want %q", srv.acpConfig.ContainerUser, "node")
	}
}

func TestUpdateAfterBootstrap_DoesNotOverrideExistingContainerUser(t *testing.T) {
	ptyManager := pty.NewManager(pty.ManagerConfig{
		DefaultShell:  "/bin/sh",
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

	if srv.config.ContainerUser != "existing-user" {
		t.Errorf("config.ContainerUser = %q, want %q (should not overwrite)", srv.config.ContainerUser, "existing-user")
	}
	if srv.acpConfig.ContainerUser != "existing-user" {
		t.Errorf("acpConfig.ContainerUser = %q, want %q (should not overwrite)", srv.acpConfig.ContainerUser, "existing-user")
	}
}

func TestUpdateAfterBootstrap_SkipsEmptyContainerUser(t *testing.T) {
	srv := newTestServerPreBootstrap(t, nil)

	postBootstrapCfg := &config.Config{
		ContainerUser: "  ", // whitespace only
		CallbackToken: "test-token",
	}

	srv.UpdateAfterBootstrap(postBootstrapCfg)

	if strings.TrimSpace(srv.config.ContainerUser) != "" {
		t.Errorf("config.ContainerUser = %q, want empty", srv.config.ContainerUser)
	}
	if strings.TrimSpace(srv.acpConfig.ContainerUser) != "" {
		t.Errorf("acpConfig.ContainerUser = %q, want empty", srv.acpConfig.ContainerUser)
	}
}

// TestBootstrapLifecycle_SessionsUseDetectedUser is the regression test that
// would have caught the original bug. It simulates the full startup lifecycle:
//
//  1. Server created with empty ContainerUser (pre-bootstrap)
//  2. Bootstrap detects ContainerUser = "node"
//  3. UpdateAfterBootstrap propagates it
//  4. PTY session created afterwards must use -u node in docker exec
//
// If step 3 is removed or broken, this test fails.
func TestBootstrapLifecycle_SessionsUseDetectedUser(t *testing.T) {
	containerID := "test-container-lifecycle"
	resolver := func() (string, error) {
		return containerID, nil
	}

	// Step 1: Server created before bootstrap (empty ContainerUser)
	srv := newTestServerPreBootstrap(t, resolver)

	// Step 2: Simulate bootstrap discovering the user
	postBootstrapCfg := &config.Config{
		ContainerUser: "node",
		CallbackToken: "test-token",
	}

	// Step 3: Propagate
	srv.UpdateAfterBootstrap(postBootstrapCfg)

	// Step 4: Create a PTY session — it must use the detected user
	session, err := srv.ptyManager.CreateSession("test-user", 24, 80)
	if err != nil {
		t.Fatalf("CreateSession after bootstrap: %v", err)
	}
	defer srv.ptyManager.CloseAllSessions()

	if session.Cmd == nil {
		t.Fatal("session command is nil")
	}

	args := strings.Join(session.Cmd.Args, " ")
	if !strings.Contains(args, "-u node") {
		t.Errorf("PTY session after bootstrap should use '-u node', got args: %s", args)
	}
	if !strings.Contains(args, containerID) {
		t.Errorf("PTY session should exec into %s, got args: %s", containerID, args)
	}
}

// TestBootstrapLifecycle_WorkspaceRuntimesUseDetectedUser verifies that
// workspace runtimes created after bootstrap inherit the detected user
// from s.config.ContainerUser (which upsertWorkspaceRuntime reads).
func TestBootstrapLifecycle_WorkspaceRuntimesUseDetectedUser(t *testing.T) {
	srv := newTestServerPreBootstrap(t, nil)

	// Before bootstrap: config has empty user
	if srv.config.ContainerUser != "" {
		t.Fatalf("pre-bootstrap config.ContainerUser should be empty, got %q", srv.config.ContainerUser)
	}

	// Simulate bootstrap
	srv.UpdateAfterBootstrap(&config.Config{
		ContainerUser: "node",
		CallbackToken: "test-token",
	})

	// After bootstrap: config should have the detected user
	if srv.config.ContainerUser != "node" {
		t.Errorf("post-bootstrap config.ContainerUser = %q, want %q", srv.config.ContainerUser, "node")
	}

	// Create a workspace runtime — it should pick up the user from config
	runtime := srv.upsertWorkspaceRuntime("ws-test", "https://github.com/test/repo", "main", "running", "")
	if runtime.ContainerUser != "node" {
		t.Errorf("workspace runtime ContainerUser = %q, want %q", runtime.ContainerUser, "node")
	}
}
