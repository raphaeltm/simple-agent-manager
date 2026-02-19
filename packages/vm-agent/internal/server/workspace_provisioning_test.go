package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
	prepareWorkspaceForRuntime = func(_ context.Context, cfg *config.Config, state bootstrap.ProvisionState) (bool, error) {
		copyCfg := *cfg
		capturedCfg = &copyCfg
		capturedState = state
		return false, nil
	}

	runtime := &WorkspaceRuntime{
		ID:                  "WS_TEST",
		Repository:          "",
		Branch:              "main",
		WorkspaceDir:        "/workspace/WS_TEST",
		ContainerLabelValue: "/workspace/WS_TEST",
		ContainerWorkDir:    "/workspaces/WS_TEST",
		ContainerUser:       "node",
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
	if capturedCfg.ContainerUser != runtime.ContainerUser {
		t.Fatalf("ContainerUser = %q, want %q", capturedCfg.ContainerUser, runtime.ContainerUser)
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
	prepareWorkspaceForRuntime = func(_ context.Context, _ *config.Config, _ bootstrap.ProvisionState) (bool, error) {
		called = true
		return false, nil
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

func TestProvisionWorkspaceRuntimeAppliesDetectedContainerUser(t *testing.T) {
	originalPrepare := prepareWorkspaceForRuntime
	defer func() { prepareWorkspaceForRuntime = originalPrepare }()

	prepareWorkspaceForRuntime = func(_ context.Context, cfg *config.Config, _ bootstrap.ProvisionState) (bool, error) {
		cfg.ContainerUser = "vscode"
		return false, nil
	}

	runtime := &WorkspaceRuntime{
		ID:                  "WS_TEST",
		Status:              "creating",
		WorkspaceDir:        "/workspace/WS_TEST",
		ContainerLabelValue: "/workspace/WS_TEST",
		ContainerWorkDir:    "/workspaces/WS_TEST",
		PTY:                 nil,
	}

	s := &Server{
		config: &config.Config{
			ContainerMode:       true,
			WorkspaceDir:        "/workspace",
			DefaultShell:        "/bin/bash",
			DefaultRows:         24,
			DefaultCols:         80,
			ContainerLabelKey:   "devcontainer.local_folder",
			PTYOutputBufferSize: 1024,
		},
		workspaces:      map[string]*WorkspaceRuntime{runtime.ID: runtime},
		workspaceEvents: map[string][]EventRecord{},
	}

	if _, err := s.provisionWorkspaceRuntime(context.Background(), runtime); err != nil {
		t.Fatalf("provisionWorkspaceRuntime() error = %v", err)
	}

	if runtime.ContainerUser != "vscode" {
		t.Fatalf("runtime.ContainerUser = %q, want %q", runtime.ContainerUser, "vscode")
	}
}

func TestRecoverWorkspaceRuntimeHydratesMetadataAndAdoptsLegacyLayout(t *testing.T) {
	originalPrepare := prepareWorkspaceForRuntime
	defer func() { prepareWorkspaceForRuntime = originalPrepare }()

	var capturedCfg *config.Config
	var capturedState bootstrap.ProvisionState
	prepareWorkspaceForRuntime = func(_ context.Context, cfg *config.Config, state bootstrap.ProvisionState) (bool, error) {
		copyCfg := *cfg
		capturedCfg = &copyCfg
		capturedState = state
		return false, nil
	}

	const workspaceID = "WS_TEST"
	const callbackToken = "node-callback-token"
	tmpDir := t.TempDir()
	legacyDir := filepath.Join(tmpDir, "repo-one")
	if err := os.MkdirAll(legacyDir, 0o755); err != nil {
		t.Fatalf("failed to create legacy workspace dir: %v", err)
	}

	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+callbackToken {
			t.Fatalf("unexpected Authorization header: %q", r.Header.Get("Authorization"))
		}
		switch r.URL.Path {
		case "/api/workspaces/WS_TEST/runtime":
			_, _ = w.Write([]byte(`{"workspaceId":"WS_TEST","repository":"octo/repo-one","branch":"main"}`))
		case "/api/workspaces/WS_TEST/git-token":
			_, _ = w.Write([]byte(`{"token":"ghs_recovery_token","expiresAt":"2026-02-12T00:00:00Z"}`))
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer controlPlane.Close()

	runtime := &WorkspaceRuntime{
		ID:                  workspaceID,
		WorkspaceDir:        filepath.Join(tmpDir, workspaceID),
		ContainerLabelValue: filepath.Join(tmpDir, workspaceID),
		ContainerWorkDir:    deriveContainerWorkDir(filepath.Join(tmpDir, workspaceID)),
	}

	s := &Server{
		config: &config.Config{
			ContainerMode:       true,
			WorkspaceDir:        tmpDir,
			CallbackToken:       callbackToken,
			ControlPlaneURL:     controlPlane.URL,
			DefaultShell:        "/bin/bash",
			DefaultRows:         24,
			DefaultCols:         80,
			ContainerLabelKey:   "devcontainer.local_folder",
			PTYOutputBufferSize: 1024,
		},
		workspaces: map[string]*WorkspaceRuntime{runtime.ID: runtime},
	}

	if err := s.recoverWorkspaceRuntime(context.Background(), runtime); err != nil {
		t.Fatalf("recoverWorkspaceRuntime() error = %v", err)
	}
	if capturedCfg == nil {
		t.Fatal("expected prepareWorkspaceForRuntime to be called")
	}

	if capturedCfg.Repository != "octo/repo-one" {
		t.Fatalf("Repository = %q, want %q", capturedCfg.Repository, "octo/repo-one")
	}
	if capturedCfg.WorkspaceDir != legacyDir {
		t.Fatalf("WorkspaceDir = %q, want %q", capturedCfg.WorkspaceDir, legacyDir)
	}
	if capturedCfg.ContainerLabelValue != legacyDir {
		t.Fatalf("ContainerLabelValue = %q, want %q", capturedCfg.ContainerLabelValue, legacyDir)
	}
	if capturedState.GitHubToken != "ghs_recovery_token" {
		t.Fatalf("GitHubToken = %q, want %q", capturedState.GitHubToken, "ghs_recovery_token")
	}
}

func TestRecoverWorkspaceRuntimeAdoptsLegacyLayoutFromBaseWorkspaceDir(t *testing.T) {
	originalPrepare := prepareWorkspaceForRuntime
	defer func() { prepareWorkspaceForRuntime = originalPrepare }()

	var capturedCfg *config.Config
	prepareWorkspaceForRuntime = func(_ context.Context, cfg *config.Config, _ bootstrap.ProvisionState) (bool, error) {
		copyCfg := *cfg
		capturedCfg = &copyCfg
		return false, nil
	}

	const workspaceID = "WS_BASE"
	const callbackToken = "node-callback-token"
	baseDir := t.TempDir()
	legacyDir := filepath.Join(baseDir, "repo-one")
	if err := os.MkdirAll(legacyDir, 0o755); err != nil {
		t.Fatalf("failed to create legacy workspace dir: %v", err)
	}

	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+callbackToken {
			t.Fatalf("unexpected Authorization header: %q", r.Header.Get("Authorization"))
		}
		switch r.URL.Path {
		case "/api/workspaces/WS_BASE/runtime":
			_, _ = w.Write([]byte(`{"workspaceId":"WS_BASE","repository":"octo/repo-one","branch":"main"}`))
		case "/api/workspaces/WS_BASE/git-token":
			_, _ = w.Write([]byte(`{"token":"ghs_recovery_token","expiresAt":"2026-02-12T00:00:00Z"}`))
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer controlPlane.Close()

	runtime := &WorkspaceRuntime{
		ID:                  workspaceID,
		WorkspaceDir:        baseDir,
		ContainerLabelValue: baseDir,
		ContainerWorkDir:    deriveContainerWorkDir(baseDir),
	}

	s := &Server{
		config: &config.Config{
			ContainerMode:       true,
			WorkspaceDir:        baseDir,
			CallbackToken:       callbackToken,
			ControlPlaneURL:     controlPlane.URL,
			DefaultShell:        "/bin/bash",
			DefaultRows:         24,
			DefaultCols:         80,
			ContainerLabelKey:   "devcontainer.local_folder",
			PTYOutputBufferSize: 1024,
		},
		workspaces: map[string]*WorkspaceRuntime{runtime.ID: runtime},
	}

	if err := s.recoverWorkspaceRuntime(context.Background(), runtime); err != nil {
		t.Fatalf("recoverWorkspaceRuntime() error = %v", err)
	}
	if capturedCfg == nil {
		t.Fatal("expected prepareWorkspaceForRuntime to be called")
	}
	if capturedCfg.WorkspaceDir != legacyDir {
		t.Fatalf("WorkspaceDir = %q, want %q", capturedCfg.WorkspaceDir, legacyDir)
	}
	if capturedCfg.ContainerLabelValue != legacyDir {
		t.Fatalf("ContainerLabelValue = %q, want %q", capturedCfg.ContainerLabelValue, legacyDir)
	}
}

func TestAdoptLegacyWorkspaceLayoutKeepsExistingNonBaseDir(t *testing.T) {
	baseDir := t.TempDir()
	existingDir := filepath.Join(baseDir, "custom-path")
	legacyDir := filepath.Join(baseDir, "repo-one")
	if err := os.MkdirAll(existingDir, 0o755); err != nil {
		t.Fatalf("failed to create existing workspace dir: %v", err)
	}
	if err := os.MkdirAll(legacyDir, 0o755); err != nil {
		t.Fatalf("failed to create legacy workspace dir: %v", err)
	}

	runtime := &WorkspaceRuntime{
		ID:                  "WS_KEEP",
		Repository:          "octo/repo-one",
		WorkspaceDir:        existingDir,
		ContainerLabelValue: existingDir,
		ContainerWorkDir:    deriveContainerWorkDir(existingDir),
	}

	s := &Server{
		config: &config.Config{
			WorkspaceDir: baseDir,
		},
	}

	if adopted := s.adoptLegacyWorkspaceLayout(runtime); adopted {
		t.Fatal("expected existing non-base workspace dir to be preserved")
	}
	if runtime.WorkspaceDir != existingDir {
		t.Fatalf("WorkspaceDir mutated = %q, want %q", runtime.WorkspaceDir, existingDir)
	}
	if runtime.ContainerLabelValue != existingDir {
		t.Fatalf("ContainerLabelValue mutated = %q, want %q", runtime.ContainerLabelValue, existingDir)
	}
}

func TestRepositoryDirName(t *testing.T) {
	tests := []struct {
		name       string
		repository string
		want       string
	}{
		{
			name:       "owner repo path",
			repository: "octo/repo-name",
			want:       "repo-name",
		},
		{
			name:       "https repo url",
			repository: "https://github.com/octo/repo.git",
			want:       "repo",
		},
		{
			name:       "sanitizes unsafe characters",
			repository: "https://example.com/octo/repo name",
			want:       "repo-name",
		},
		{
			name:       "empty value",
			repository: " ",
			want:       "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := repositoryDirName(tt.repository); got != tt.want {
				t.Fatalf("repositoryDirName(%q) = %q, want %q", tt.repository, got, tt.want)
			}
		})
	}
}

func TestRecoverWorkspaceRuntimePropagatesFallbackFlag(t *testing.T) {
	originalPrepare := prepareWorkspaceForRuntime
	defer func() { prepareWorkspaceForRuntime = originalPrepare }()

	// Mock that returns usedFallback=true
	prepareWorkspaceForRuntime = func(_ context.Context, _ *config.Config, _ bootstrap.ProvisionState) (bool, error) {
		return true, nil
	}

	runtime := &WorkspaceRuntime{
		ID:                  "WS_FALLBACK",
		Repository:          "",
		Branch:              "main",
		WorkspaceDir:        "/workspace/WS_FALLBACK",
		ContainerLabelValue: "/workspace/WS_FALLBACK",
		ContainerWorkDir:    "/workspaces/WS_FALLBACK",
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

	// recoverWorkspaceRuntime uses the mock variable prepareWorkspaceForRuntime
	err := s.recoverWorkspaceRuntime(context.Background(), runtime)
	if err != nil {
		t.Fatalf("recoverWorkspaceRuntime() error = %v", err)
	}
	// The fallback flag is consumed internally; the test verifies no error
	// when prepareWorkspaceForRuntime returns (true, nil).
}
