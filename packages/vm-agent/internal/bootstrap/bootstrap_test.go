package bootstrap

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

func TestNormalizeRepoURL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "owner slash repo",
			in:   "octo/repo",
			want: "https://github.com/octo/repo.git",
		},
		{
			name: "full url without dot git",
			in:   "https://github.com/octo/repo",
			want: "https://github.com/octo/repo.git",
		},
		{
			name: "full url with dot git",
			in:   "https://github.com/octo/repo.git",
			want: "https://github.com/octo/repo.git",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := normalizeRepoURL(tc.in)
			if got != tc.want {
				t.Fatalf("normalizeRepoURL(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestWithGitHubToken(t *testing.T) {
	t.Parallel()

	urlWithToken, err := withGitHubToken("https://github.com/octo/repo.git", "abc123")
	if err != nil {
		t.Fatalf("withGitHubToken returned error: %v", err)
	}
	if urlWithToken != "https://x-access-token:abc123@github.com/octo/repo.git" {
		t.Fatalf("unexpected tokenized url: %s", urlWithToken)
	}

	nonGithubURL, err := withGitHubToken("https://gitlab.com/octo/repo.git", "abc123")
	if err != nil {
		t.Fatalf("withGitHubToken returned error for non-github url: %v", err)
	}
	if nonGithubURL != "https://gitlab.com/octo/repo.git" {
		t.Fatalf("expected non-github URL to remain unchanged, got: %s", nonGithubURL)
	}
}

func TestIsGitHubRepo(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		repo string
		want bool
	}{
		{name: "owner/repo", repo: "octo/repo", want: true},
		{name: "github URL", repo: "https://github.com/octo/repo.git", want: true},
		{name: "gitlab URL", repo: "https://gitlab.com/octo/repo.git", want: false},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := isGitHubRepo(tc.repo); got != tc.want {
				t.Fatalf("isGitHubRepo(%q) = %v, want %v", tc.repo, got, tc.want)
			}
		})
	}
}

func TestRenderGitCredentialHelperScript(t *testing.T) {
	t.Parallel()

	cfg := &config.Config{
		Port:          8080,
		CallbackToken: "callback-token-123",
	}

	script, err := renderGitCredentialHelperScript(cfg)
	if err != nil {
		t.Fatalf("renderGitCredentialHelperScript returned error: %v", err)
	}

	required := []string{
		`Authorization: Bearer callback-token-123`,
		`http://${target}:8080/git-credential`,
		"host.docker.internal",
		"172.17.0.1",
	}

	for _, fragment := range required {
		if !strings.Contains(script, fragment) {
			t.Fatalf("expected script to contain %q", fragment)
		}
	}
}

func TestRenderGitCredentialHelperScriptValidation(t *testing.T) {
	t.Parallel()

	if _, err := renderGitCredentialHelperScript(nil); err == nil {
		t.Fatal("expected error for nil config")
	}

	if _, err := renderGitCredentialHelperScript(&config.Config{Port: 8080}); err == nil {
		t.Fatal("expected error for missing callback token")
	}

	if _, err := renderGitCredentialHelperScript(&config.Config{CallbackToken: "token", Port: 0}); err == nil {
		t.Fatal("expected error for invalid port")
	}
}

func TestSaveAndLoadState(t *testing.T) {
	t.Parallel()

	tmpDir := t.TempDir()
	statePath := filepath.Join(tmpDir, "state", "bootstrap-state.json")

	input := &bootstrapState{
		WorkspaceID:   "ws-123",
		CallbackToken: "callback-token",
		GitHubToken:   "gh-token",
	}

	if err := saveState(statePath, input); err != nil {
		t.Fatalf("saveState failed: %v", err)
	}

	loaded, err := loadState(statePath)
	if err != nil {
		t.Fatalf("loadState failed: %v", err)
	}

	if loaded == nil {
		t.Fatal("loadState returned nil state")
	}
	if loaded.WorkspaceID != input.WorkspaceID || loaded.CallbackToken != input.CallbackToken || loaded.GitHubToken != input.GitHubToken {
		t.Fatalf("loaded state mismatch: got %+v want %+v", loaded, input)
	}
}

func TestRedeemBootstrapTokenSuccess(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"workspaceId":"ws-123","callbackToken":"cb-123","githubToken":"gh-123","gitUserName":"Octo Cat","gitUserEmail":"octo@example.com","controlPlaneUrl":"http://api.example.com"}`))
	}))
	defer server.Close()

	cfg := &config.Config{
		ControlPlaneURL: server.URL,
		BootstrapToken:  "bootstrap-123",
		WorkspaceID:     "ws-123",
	}

	state, retryable, err := redeemBootstrapToken(context.Background(), cfg)
	if err != nil {
		t.Fatalf("redeemBootstrapToken returned error: %v", err)
	}
	if retryable {
		t.Fatal("expected retryable=false on success")
	}
	if state.WorkspaceID != "ws-123" || state.CallbackToken != "cb-123" || state.GitHubToken != "gh-123" {
		t.Fatalf("unexpected state: %+v", state)
	}
	if state.GitUserName != "Octo Cat" || state.GitUserEmail != "octo@example.com" {
		t.Fatalf("unexpected git identity: name=%q email=%q", state.GitUserName, state.GitUserEmail)
	}
}

func TestRedeemBootstrapTokenUnauthorizedIsNotRetryable(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"INVALID_TOKEN","message":"expired"}`))
	}))
	defer server.Close()

	cfg := &config.Config{
		ControlPlaneURL: server.URL,
		BootstrapToken:  "expired",
		WorkspaceID:     "ws-123",
	}

	_, retryable, err := redeemBootstrapToken(context.Background(), cfg)
	if err == nil {
		t.Fatal("expected redeemBootstrapToken to fail")
	}
	if retryable {
		t.Fatal("expected unauthorized response to be non-retryable")
	}
}

func TestLoadStateMissingFile(t *testing.T) {
	t.Parallel()

	state, err := loadState(filepath.Join(t.TempDir(), "does-not-exist.json"))
	if err != nil {
		t.Fatalf("loadState returned error for missing file: %v", err)
	}
	if state != nil {
		t.Fatalf("expected nil state for missing file, got: %+v", state)
	}
}

func TestRedeemBootstrapTokenRespectsContext(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(100 * time.Millisecond)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	cfg := &config.Config{
		ControlPlaneURL:  server.URL,
		BootstrapToken:   "slow",
		WorkspaceID:      "ws-123",
		BootstrapMaxWait: 50 * time.Millisecond,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	_, _, err := redeemBootstrapToken(ctx, cfg)
	if err == nil {
		t.Fatal("expected error when context times out")
	}
}

func TestSaveStatePermissions(t *testing.T) {
	t.Parallel()

	tmpDir := t.TempDir()
	statePath := filepath.Join(tmpDir, "state", "bootstrap-state.json")
	input := &bootstrapState{
		WorkspaceID:   "ws-123",
		CallbackToken: "cb-123",
	}

	if err := saveState(statePath, input); err != nil {
		t.Fatalf("saveState failed: %v", err)
	}

	info, err := os.Stat(statePath)
	if err != nil {
		t.Fatalf("stat failed: %v", err)
	}

	if info.Mode().Perm() != 0o600 {
		t.Fatalf("expected mode 0600, got %o", info.Mode().Perm())
	}
}

func TestResolveGitIdentity(t *testing.T) {
	t.Parallel()

	name, email, ok := resolveGitIdentity(nil)
	if ok {
		t.Fatalf("expected no identity for nil state, got %q <%s>", name, email)
	}

	name, email, ok = resolveGitIdentity(&bootstrapState{GitUserName: "Octo Cat", GitUserEmail: "octo@example.com"})
	if !ok {
		t.Fatal("expected git identity to resolve")
	}
	if name != "Octo Cat" || email != "octo@example.com" {
		t.Fatalf("unexpected identity: %q <%s>", name, email)
	}

	name, email, ok = resolveGitIdentity(&bootstrapState{GitUserEmail: "octo@example.com"})
	if !ok {
		t.Fatal("expected git identity to resolve with email fallback")
	}
	if name != "octo" || email != "octo@example.com" {
		t.Fatalf("unexpected derived identity: %q <%s>", name, email)
	}
}

func TestRedactSecret(t *testing.T) {
	t.Parallel()

	input := "https://x-access-token:secret@github.com/octo/repo.git"
	got := redactSecret(input, "secret")
	want := "https://x-access-token:***@github.com/octo/repo.git"

	if got != want {
		t.Fatalf("redactSecret() = %q, want %q", got, want)
	}
}

func TestWaitForCommandAlreadyAvailable(t *testing.T) {
	t.Parallel()

	// "ls" should be available on any system
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	if err := waitForCommand(ctx, "ls"); err != nil {
		t.Fatalf("waitForCommand(ls) returned error for available command: %v", err)
	}
}

func TestWaitForCommandCancelledContext(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancel immediately

	err := waitForCommand(ctx, "nonexistent-command-that-will-never-exist")
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
	if !strings.Contains(err.Error(), "context cancelled") && !strings.Contains(err.Error(), "context canceled") {
		t.Fatalf("expected context cancellation error, got: %v", err)
	}
}

func TestWaitForCommandTimesOut(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	err := waitForCommand(ctx, "nonexistent-command-that-will-never-exist")
	if err == nil {
		t.Fatal("expected error for timed out context")
	}
}

func TestWriteDefaultDevcontainerConfig(t *testing.T) {
	t.Parallel()

	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "sam", "default-devcontainer.json")

	cfg := &config.Config{
		DefaultDevcontainerImage:      "mcr.microsoft.com/devcontainers/base:ubuntu",
		DefaultDevcontainerConfigPath: configPath,
	}

	gotPath, err := writeDefaultDevcontainerConfig(cfg)
	if err != nil {
		t.Fatalf("writeDefaultDevcontainerConfig returned error: %v", err)
	}
	if gotPath != configPath {
		t.Fatalf("expected path %q, got %q", configPath, gotPath)
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("failed to read written config: %v", err)
	}

	content := string(data)
	required := []string{
		`"mcr.microsoft.com/devcontainers/base:ubuntu"`,
		`"ghcr.io/devcontainers/features/git:1"`,
		`"ghcr.io/devcontainers/features/github-cli:1"`,
		`"remoteUser": "vscode"`,
	}
	for _, fragment := range required {
		if !strings.Contains(content, fragment) {
			t.Fatalf("expected config to contain %q, got:\n%s", fragment, content)
		}
	}
}

func TestWriteDefaultDevcontainerConfigCustomImage(t *testing.T) {
	t.Parallel()

	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "custom-config.json")

	cfg := &config.Config{
		DefaultDevcontainerImage:      "mcr.microsoft.com/devcontainers/base:ubuntu-24.04",
		DefaultDevcontainerConfigPath: configPath,
	}

	_, err := writeDefaultDevcontainerConfig(cfg)
	if err != nil {
		t.Fatalf("writeDefaultDevcontainerConfig returned error: %v", err)
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("failed to read written config: %v", err)
	}

	if !strings.Contains(string(data), `"mcr.microsoft.com/devcontainers/base:ubuntu-24.04"`) {
		t.Fatalf("expected custom image in config, got:\n%s", string(data))
	}
}

func TestWriteDefaultDevcontainerConfigFallbackDefaults(t *testing.T) {
	t.Parallel()

	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "fallback-config.json")

	// Empty image/path fields should fall back to package-level defaults
	cfg := &config.Config{
		DefaultDevcontainerImage:      "",
		DefaultDevcontainerConfigPath: configPath,
	}

	_, err := writeDefaultDevcontainerConfig(cfg)
	if err != nil {
		t.Fatalf("writeDefaultDevcontainerConfig returned error: %v", err)
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("failed to read written config: %v", err)
	}

	if !strings.Contains(string(data), config.DefaultDevcontainerImage) {
		t.Fatalf("expected fallback to default image %q, got:\n%s", config.DefaultDevcontainerImage, string(data))
	}
}

func TestHasDevcontainerConfig(t *testing.T) {
	t.Parallel()

	t.Run("no config", func(t *testing.T) {
		t.Parallel()
		tmpDir := t.TempDir()
		if hasDevcontainerConfig(tmpDir) {
			t.Fatal("expected hasDevcontainerConfig to return false for empty dir")
		}
	})

	t.Run("with .devcontainer/devcontainer.json", func(t *testing.T) {
		t.Parallel()
		tmpDir := t.TempDir()
		dcDir := filepath.Join(tmpDir, ".devcontainer")
		if err := os.MkdirAll(dcDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dcDir, "devcontainer.json"), []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
		if !hasDevcontainerConfig(tmpDir) {
			t.Fatal("expected hasDevcontainerConfig to return true")
		}
	})

	t.Run("with .devcontainer.json", func(t *testing.T) {
		t.Parallel()
		tmpDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(tmpDir, ".devcontainer.json"), []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
		if !hasDevcontainerConfig(tmpDir) {
			t.Fatal("expected hasDevcontainerConfig to return true")
		}
	})
}

func TestEnsureWorkspaceWritablePreDevcontainerNoopWhenContainerModeDisabled(t *testing.T) {
	t.Parallel()

	workspaceDir := t.TempDir()
	targetFile := filepath.Join(workspaceDir, "package-lock.json")
	if err := os.WriteFile(targetFile, []byte("{}"), 0o600); err != nil {
		t.Fatalf("failed to write target file: %v", err)
	}

	cfg := &config.Config{
		WorkspaceDir:  workspaceDir,
		ContainerMode: false,
	}
	if err := ensureWorkspaceWritablePreDevcontainer(context.Background(), cfg); err != nil {
		t.Fatalf("ensureWorkspaceWritablePreDevcontainer returned error: %v", err)
	}

	info, err := os.Stat(targetFile)
	if err != nil {
		t.Fatalf("stat target file failed: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("expected mode 0600 when container mode is disabled, got %o", info.Mode().Perm())
	}
}

func TestEnsureWorkspaceWritablePreDevcontainerMakesWorkspaceWritable(t *testing.T) {
	t.Parallel()

	workspaceDir := t.TempDir()
	subDir := filepath.Join(workspaceDir, "subdir")
	if err := os.MkdirAll(subDir, 0o700); err != nil {
		t.Fatalf("failed to create subdir: %v", err)
	}
	targetFile := filepath.Join(workspaceDir, "package-lock.json")
	if err := os.WriteFile(targetFile, []byte("{}"), 0o600); err != nil {
		t.Fatalf("failed to write target file: %v", err)
	}

	cfg := &config.Config{
		WorkspaceDir:  workspaceDir,
		ContainerMode: true,
	}
	if err := ensureWorkspaceWritablePreDevcontainer(context.Background(), cfg); err != nil {
		t.Fatalf("ensureWorkspaceWritablePreDevcontainer returned error: %v", err)
	}

	fileInfo, err := os.Stat(targetFile)
	if err != nil {
		t.Fatalf("stat target file failed: %v", err)
	}
	if fileInfo.Mode().Perm()&0o666 != 0o666 {
		t.Fatalf("expected file mode to include 0666 bits, got %o", fileInfo.Mode().Perm())
	}

	dirInfo, err := os.Stat(subDir)
	if err != nil {
		t.Fatalf("stat subdir failed: %v", err)
	}
	if dirInfo.Mode().Perm()&0o777 != 0o777 {
		t.Fatalf("expected directory mode to include 0777 bits, got %o", dirInfo.Mode().Perm())
	}
}

func TestPrepareWorkspaceMarksReady(t *testing.T) {
	mockBinDir := t.TempDir()
	mockDevcontainer := filepath.Join(mockBinDir, "devcontainer")
	mockScript := "#!/bin/sh\nexit 0\n"
	if err := os.WriteFile(mockDevcontainer, []byte(mockScript), 0o755); err != nil {
		t.Fatalf("failed to write mock devcontainer command: %v", err)
	}

	origPath := os.Getenv("PATH")
	t.Setenv("PATH", mockBinDir+":"+origPath)

	workspaceID := "ws-prepare-ready"
	callbackToken := "cb-prepare-ready"
	readyCalled := false
	readyAuth := ""

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/workspaces/"+workspaceID+"/ready" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}

		readyCalled = true
		readyAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"running"}`))
	}))
	defer server.Close()

	cfg := &config.Config{
		WorkspaceID:                   workspaceID,
		ControlPlaneURL:               server.URL,
		CallbackToken:                 callbackToken,
		WorkspaceDir:                  t.TempDir(),
		ContainerMode:                 false,
		DefaultDevcontainerConfigPath: filepath.Join(t.TempDir(), "default-devcontainer.json"),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := PrepareWorkspace(ctx, cfg, ProvisionState{}); err != nil {
		t.Fatalf("PrepareWorkspace returned error: %v", err)
	}

	if !readyCalled {
		t.Fatal("expected PrepareWorkspace to call the /ready callback")
	}
	if readyAuth != "Bearer "+callbackToken {
		t.Fatalf("unexpected ready callback auth header: got %q", readyAuth)
	}
}

func TestPrepareWorkspaceReturnsReadyEndpointError(t *testing.T) {
	mockBinDir := t.TempDir()
	mockDevcontainer := filepath.Join(mockBinDir, "devcontainer")
	mockScript := "#!/bin/sh\nexit 0\n"
	if err := os.WriteFile(mockDevcontainer, []byte(mockScript), 0o755); err != nil {
		t.Fatalf("failed to write mock devcontainer command: %v", err)
	}

	origPath := os.Getenv("PATH")
	t.Setenv("PATH", mockBinDir+":"+origPath)

	workspaceID := "ws-prepare-ready-failure"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/workspaces/"+workspaceID+"/ready" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}

		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"INTERNAL_ERROR"}`))
	}))
	defer server.Close()

	cfg := &config.Config{
		WorkspaceID:                   workspaceID,
		ControlPlaneURL:               server.URL,
		CallbackToken:                 "cb-failure",
		WorkspaceDir:                  t.TempDir(),
		ContainerMode:                 false,
		DefaultDevcontainerConfigPath: filepath.Join(t.TempDir(), "default-devcontainer.json"),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err := PrepareWorkspace(ctx, cfg, ProvisionState{})
	if err == nil {
		t.Fatal("expected PrepareWorkspace to fail when /ready returns non-2xx")
	}
	if !strings.Contains(err.Error(), "ready endpoint returned HTTP 500") {
		t.Fatalf("expected ready endpoint error, got: %v", err)
	}
}
