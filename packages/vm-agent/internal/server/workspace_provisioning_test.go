package server

import (
	"context"
	"errors"
	"testing"

	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/config"
)

func TestIsContainerUnavailableError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "matches devcontainer wrapper error",
			err:  errors.New("devcontainer not available: no running devcontainer found (label: devcontainer.local_folder=/workspace/ws-1)"),
			want: true,
		},
		{
			name: "matches discovery error directly",
			err:  errors.New("no running devcontainer found (label: devcontainer.local_folder=/workspace/ws-1)"),
			want: true,
		},
		{
			name: "ignores unrelated error",
			err:  errors.New("permission denied"),
			want: false,
		},
		{
			name: "nil error",
			err:  nil,
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isContainerUnavailableError(tt.err); got != tt.want {
				t.Fatalf("isContainerUnavailableError() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestRecoverWorkspaceRuntimeUsesRuntimeConfig(t *testing.T) {
	originalPrepare := prepareWorkspaceForRuntime
	defer func() { prepareWorkspaceForRuntime = originalPrepare }()

	var capturedCfg *config.Config
	var capturedState bootstrap.ProvisionState
	prepareWorkspaceForRuntime = func(_ context.Context, cfg *config.Config, state bootstrap.ProvisionState) error {
		copyCfg := *cfg
		capturedCfg = &copyCfg
		capturedState = state
		return nil
	}

	runtime := &WorkspaceRuntime{
		ID:                  "WS_TEST",
		Repository:          "",
		Branch:              "main",
		WorkspaceDir:        "/workspace/WS_TEST",
		ContainerLabelValue: "/workspace/WS_TEST",
		ContainerWorkDir:    "/workspaces/WS_TEST",
		CallbackToken:       "workspace-callback-token",
	}

	s := &Server{
		config: &config.Config{
			ContainerMode: true,
			WorkspaceDir:  "/workspace",
			CallbackToken: "node-callback-token",
		},
		workspaces: map[string]*WorkspaceRuntime{runtime.ID: runtime},
	}

	if err := s.recoverWorkspaceRuntime(context.Background(), runtime); err != nil {
		t.Fatalf("recoverWorkspaceRuntime() error = %v", err)
	}

	if capturedCfg == nil {
		t.Fatal("expected prepareWorkspaceForRuntime to be called")
	}
	if capturedCfg.WorkspaceID != runtime.ID {
		t.Fatalf("WorkspaceID = %q, want %q", capturedCfg.WorkspaceID, runtime.ID)
	}
	if capturedCfg.WorkspaceDir != runtime.WorkspaceDir {
		t.Fatalf("WorkspaceDir = %q, want %q", capturedCfg.WorkspaceDir, runtime.WorkspaceDir)
	}
	if capturedCfg.ContainerLabelValue != runtime.ContainerLabelValue {
		t.Fatalf("ContainerLabelValue = %q, want %q", capturedCfg.ContainerLabelValue, runtime.ContainerLabelValue)
	}
	if capturedCfg.ContainerWorkDir != runtime.ContainerWorkDir {
		t.Fatalf("ContainerWorkDir = %q, want %q", capturedCfg.ContainerWorkDir, runtime.ContainerWorkDir)
	}
	if capturedCfg.CallbackToken != runtime.CallbackToken {
		t.Fatalf("CallbackToken = %q, want %q", capturedCfg.CallbackToken, runtime.CallbackToken)
	}
	if capturedState.GitHubToken != "" {
		t.Fatalf("expected empty recovery git token for empty repository, got %q", capturedState.GitHubToken)
	}
}

func TestRecoverWorkspaceRuntimeNoopWhenContainerModeDisabled(t *testing.T) {
	originalPrepare := prepareWorkspaceForRuntime
	defer func() { prepareWorkspaceForRuntime = originalPrepare }()

	called := false
	prepareWorkspaceForRuntime = func(_ context.Context, _ *config.Config, _ bootstrap.ProvisionState) error {
		called = true
		return nil
	}

	runtime := &WorkspaceRuntime{ID: "WS_TEST"}
	s := &Server{
		config: &config.Config{ContainerMode: false},
	}

	if err := s.recoverWorkspaceRuntime(context.Background(), runtime); err != nil {
		t.Fatalf("recoverWorkspaceRuntime() error = %v", err)
	}
	if called {
		t.Fatal("expected prepareWorkspaceForRuntime not to be called when container mode is disabled")
	}
}
