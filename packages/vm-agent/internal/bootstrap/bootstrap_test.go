package bootstrap

import (
	"context"
	"encoding/json"
	"fmt"
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

	// Empty email with non-empty name — should return ok=false
	_, _, ok = resolveGitIdentity(&bootstrapState{GitUserName: "Octo Cat", GitUserEmail: ""})
	if ok {
		t.Fatal("expected no identity for empty email")
	}

	// Whitespace-only email — should return ok=false
	_, _, ok = resolveGitIdentity(&bootstrapState{GitUserName: "Octo Cat", GitUserEmail: "   "})
	if ok {
		t.Fatal("expected no identity for whitespace-only email")
	}
}

func TestBuildSAMEnvScript(t *testing.T) {
	t.Parallel()

	cfg := &config.Config{
		ControlPlaneURL: "https://api.example.com",
		WorkspaceID:     "ws-123",
		NodeID:          "node-456",
		Repository:      "octo/repo",
		Branch:          "main",
	}

	script := buildSAMEnvScript(cfg, "")

	// Verify all expected variables are present.
	for _, want := range []string{
		`export SAM_API_URL="https://api.example.com"`,
		`export SAM_BRANCH="main"`,
		`export SAM_NODE_ID="node-456"`,
		`export SAM_REPOSITORY="octo/repo"`,
		`export SAM_WORKSPACE_ID="ws-123"`,
		`export SAM_WORKSPACE_URL="https://ws-ws-123.example.com"`,
	} {
		if !strings.Contains(script, want) {
			t.Errorf("script missing %q\ngot:\n%s", want, script)
		}
	}

	// GITHUB_TOKEN should NOT be present when empty.
	if strings.Contains(script, "GITHUB_TOKEN") {
		t.Errorf("script should not contain GITHUB_TOKEN when empty, got:\n%s", script)
	}

	// Verify header comment is present.
	if !strings.HasPrefix(script, "# SAM workspace") {
		t.Errorf("script missing header comment, got:\n%s", script)
	}
}

func TestBuildSAMEnvScriptOmitsEmptyValues(t *testing.T) {
	t.Parallel()

	cfg := &config.Config{
		ControlPlaneURL: "https://api.example.com",
		WorkspaceID:     "ws-123",
		// NodeID, Repository, Branch left empty
	}

	script := buildSAMEnvScript(cfg, "")

	if strings.Contains(script, "SAM_NODE_ID") {
		t.Errorf("script should not contain SAM_NODE_ID when empty, got:\n%s", script)
	}
	if strings.Contains(script, "SAM_REPOSITORY") {
		t.Errorf("script should not contain SAM_REPOSITORY when empty, got:\n%s", script)
	}
	if strings.Contains(script, "SAM_BRANCH") {
		t.Errorf("script should not contain SAM_BRANCH when empty, got:\n%s", script)
	}
	if strings.Contains(script, "GITHUB_TOKEN") {
		t.Errorf("script should not contain GITHUB_TOKEN when empty, got:\n%s", script)
	}
	// SAM_API_URL and SAM_WORKSPACE_ID should still be present.
	if !strings.Contains(script, "SAM_API_URL") {
		t.Errorf("script missing SAM_API_URL, got:\n%s", script)
	}
	if !strings.Contains(script, "SAM_WORKSPACE_ID") {
		t.Errorf("script missing SAM_WORKSPACE_ID, got:\n%s", script)
	}
}

func TestBuildSAMEnvScriptIncludesGitHubToken(t *testing.T) {
	t.Parallel()

	cfg := &config.Config{
		ControlPlaneURL: "https://api.example.com",
		WorkspaceID:     "ws-123",
		Repository:      "octo/repo",
		Branch:          "main",
	}

	script := buildSAMEnvScript(cfg, "ghs_test_token_abc123")

	want := `export GITHUB_TOKEN="ghs_test_token_abc123"`
	if !strings.Contains(script, want) {
		t.Errorf("script missing %q\ngot:\n%s", want, script)
	}

	// Other SAM vars should still be present.
	if !strings.Contains(script, "SAM_WORKSPACE_ID") {
		t.Errorf("script missing SAM_WORKSPACE_ID, got:\n%s", script)
	}
}

func TestBuildSAMEnvScriptTrimsGitHubTokenWhitespace(t *testing.T) {
	t.Parallel()

	cfg := &config.Config{
		ControlPlaneURL: "https://api.example.com",
		WorkspaceID:     "ws-123",
	}

	script := buildSAMEnvScript(cfg, "  ghs_token  ")

	want := `export GITHUB_TOKEN="ghs_token"`
	if !strings.Contains(script, want) {
		t.Errorf("expected trimmed token in script, got:\n%s", script)
	}
}

func TestBuildSAMEnvScriptWhitespaceOnlyTokenOmitted(t *testing.T) {
	t.Parallel()

	cfg := &config.Config{
		ControlPlaneURL: "https://api.example.com",
		WorkspaceID:     "ws-123",
	}

	script := buildSAMEnvScript(cfg, "   ")

	if strings.Contains(script, "GITHUB_TOKEN") {
		t.Errorf("script should not contain GITHUB_TOKEN for whitespace-only token, got:\n%s", script)
	}
}

func TestBuildProjectRuntimeEnvScript(t *testing.T) {
	t.Parallel()

	script, err := buildProjectRuntimeEnvScript([]ProjectRuntimeEnvVar{
		{Key: "API_KEY", Value: "secret"},
		{Key: "FOO_BAR", Value: "baz"},
	})
	if err != nil {
		t.Fatalf("buildProjectRuntimeEnvScript returned error: %v", err)
	}

	if !strings.Contains(script, `export API_KEY="secret"`) {
		t.Fatalf("expected script to contain API_KEY export, got:\n%s", script)
	}
	if !strings.Contains(script, `export FOO_BAR="baz"`) {
		t.Fatalf("expected script to contain FOO_BAR export, got:\n%s", script)
	}
}

func TestBuildProjectRuntimeEnvScriptRejectsInvalidKey(t *testing.T) {
	t.Parallel()

	_, err := buildProjectRuntimeEnvScript([]ProjectRuntimeEnvVar{
		{Key: "NOT-VALID", Value: "secret"},
	})
	if err == nil {
		t.Fatal("expected invalid env key to return error")
	}
}

func TestNormalizeProjectRuntimeFilePath(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{name: "relative path", input: ".env.local", want: ".env.local"},
		{name: "nested path", input: "config/app/env.txt", want: "config/app/env.txt"},
		{name: "reject absolute", input: "/etc/passwd", wantErr: true},
		{name: "reject traversal", input: "../secret.txt", wantErr: true},
		{name: "reject empty", input: "  ", wantErr: true},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := normalizeProjectRuntimeFilePath(tt.input)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("normalizeProjectRuntimeFilePath(%q) expected error", tt.input)
				}
				return
			}
			if err != nil {
				t.Fatalf("normalizeProjectRuntimeFilePath(%q) error = %v", tt.input, err)
			}
			if got != tt.want {
				t.Fatalf("normalizeProjectRuntimeFilePath(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
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

	gotPath, err := writeDefaultDevcontainerConfig(cfg, "")
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
	}
	for _, fragment := range required {
		if !strings.Contains(content, fragment) {
			t.Fatalf("expected config to contain %q, got:\n%s", fragment, content)
		}
	}

	// By default, remoteUser should NOT be present (empty DefaultDevcontainerRemoteUser)
	if strings.Contains(content, "remoteUser") {
		t.Fatalf("expected no remoteUser when DefaultDevcontainerRemoteUser is empty, got:\n%s", content)
	}
}

func TestWriteDefaultDevcontainerConfigWithRemoteUser(t *testing.T) {
	t.Parallel()

	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "remote-user-config.json")

	cfg := &config.Config{
		DefaultDevcontainerImage:      "mcr.microsoft.com/devcontainers/base:ubuntu",
		DefaultDevcontainerConfigPath: configPath,
		DefaultDevcontainerRemoteUser: "vscode",
	}

	_, err := writeDefaultDevcontainerConfig(cfg, "")
	if err != nil {
		t.Fatalf("writeDefaultDevcontainerConfig returned error: %v", err)
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("failed to read written config: %v", err)
	}

	content := string(data)
	if !strings.Contains(content, `"remoteUser": "vscode"`) {
		t.Fatalf("expected remoteUser when DefaultDevcontainerRemoteUser is set, got:\n%s", content)
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

	_, err := writeDefaultDevcontainerConfig(cfg, "")
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

	_, err := writeDefaultDevcontainerConfig(cfg, "")
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

func TestWriteDefaultDevcontainerConfigWithVolume(t *testing.T) {
	t.Parallel()

	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "volume-config.json")

	cfg := &config.Config{
		DefaultDevcontainerImage:      "mcr.microsoft.com/devcontainers/base:ubuntu",
		DefaultDevcontainerConfigPath: configPath,
		WorkspaceDir:                  "/workspace/my-repo",
		Repository:                    "owner/my-repo",
	}

	_, err := writeDefaultDevcontainerConfig(cfg, "sam-ws-abc123")
	if err != nil {
		t.Fatalf("writeDefaultDevcontainerConfig returned error: %v", err)
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("failed to read written config: %v", err)
	}

	content := string(data)
	if !strings.Contains(content, `"workspaceMount": "source=sam-ws-abc123,target=/workspaces,type=volume"`) {
		t.Fatalf("expected workspaceMount in config, got:\n%s", content)
	}
	if !strings.Contains(content, `"workspaceFolder": "/workspaces/my-repo"`) {
		t.Fatalf("expected workspaceFolder in config, got:\n%s", content)
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

func TestVolumeNameForWorkspace(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		workspaceID string
		want        string
	}{
		{name: "normal id", workspaceID: "abc123", want: "sam-ws-abc123"},
		{name: "uuid id", workspaceID: "550e8400-e29b-41d4-a716-446655440000", want: "sam-ws-550e8400-e29b-41d4-a716-446655440000"},
		{name: "empty id", workspaceID: "", want: "sam-ws-"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := VolumeNameForWorkspace(tc.workspaceID)
			if got != tc.want {
				t.Fatalf("VolumeNameForWorkspace(%q) = %q, want %q", tc.workspaceID, got, tc.want)
			}
		})
	}
}

func TestDevcontainerUpArgs(t *testing.T) {
	t.Parallel()

	t.Run("no override", func(t *testing.T) {
		t.Parallel()
		cfg := &config.Config{
			WorkspaceDir: "/workspace/my-repo",
			Repository:   "owner/my-repo",
		}
		args := devcontainerUpArgs(cfg, "")
		if len(args) != 3 {
			t.Fatalf("expected 3 args, got %d: %v", len(args), args)
		}
		if args[0] != "up" || args[1] != "--workspace-folder" || args[2] != "/workspace/my-repo" {
			t.Fatalf("unexpected args: %v", args)
		}
	})

	t.Run("with override config", func(t *testing.T) {
		t.Parallel()
		cfg := &config.Config{
			WorkspaceDir: "/workspace/my-repo",
			Repository:   "owner/my-repo",
		}
		args := devcontainerUpArgs(cfg, "/etc/sam/default-devcontainer.json")
		found := false
		for i, a := range args {
			if a == "--override-config" && i+1 < len(args) {
				if args[i+1] != "/etc/sam/default-devcontainer.json" {
					t.Fatalf("unexpected --override-config value: %s", args[i+1])
				}
				found = true
			}
		}
		if !found {
			t.Fatalf("expected --override-config flag in args: %v", args)
		}
	})

	t.Run("no --mount flag used", func(t *testing.T) {
		// Volume mount settings should be in the override config via workspaceMount,
		// NOT as a --mount CLI flag (which only adds supplementary mounts).
		t.Parallel()
		cfg := &config.Config{
			WorkspaceDir: "/workspace/my-repo",
			Repository:   "owner/my-repo",
		}
		args := devcontainerUpArgs(cfg, "/etc/sam/override.json")
		for _, a := range args {
			if a == "--mount" {
				t.Fatalf("devcontainerUpArgs should not generate --mount flag; use workspaceMount in config instead. Args: %v", args)
			}
		}
	})
}

func TestWriteMountOverrideConfig(t *testing.T) {
	mockBinDir := t.TempDir()
	mockDevcontainer := filepath.Join(mockBinDir, "devcontainer")
	mockScript := `#!/bin/sh
if [ "$1" = "read-configuration" ]; then
  echo '[trace] resolving features...'
  cat <<'EOF'
{
  "outcome": "success",
  "mergedConfiguration": {
    "name": "Repo Config",
    "image": "mcr.microsoft.com/devcontainers/typescript-node:24-bookworm",
    "postCreateCommands": [
      "bash .devcontainer/post-create.sh"
    ],
    "postStartCommands": [
      "bash .devcontainer/post-start.sh"
    ],
    "features": {
      "ghcr.io/devcontainers/features/go:1": {
        "version": "1.22"
      }
    }
  }
}
EOF
  exit 0
fi
echo "unexpected devcontainer command: $@" >&2
exit 1
`
	if err := os.WriteFile(mockDevcontainer, []byte(mockScript), 0o755); err != nil {
		t.Fatalf("failed to write mock devcontainer command: %v", err)
	}
	origPath := os.Getenv("PATH")
	t.Setenv("PATH", mockBinDir+":"+origPath)

	cfg := &config.Config{
		WorkspaceDir: "/workspace/my-repo",
		Repository:   "owner/my-repo",
	}

	path, err := writeMountOverrideConfig(context.Background(), cfg, "sam-ws-abc123")
	if err != nil {
		t.Fatalf("writeMountOverrideConfig returned error: %v", err)
	}
	defer os.Remove(path)

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read mount override config: %v", err)
	}

	content := string(data)
	if !strings.Contains(content, `"workspaceMount": "source=sam-ws-abc123,target=/workspaces,type=volume"`) {
		t.Fatalf("expected workspaceMount in config, got:\n%s", content)
	}
	if !strings.Contains(content, `"workspaceFolder": "/workspaces/my-repo"`) {
		t.Fatalf("expected workspaceFolder in config, got:\n%s", content)
	}
	if !strings.Contains(content, `"image": "mcr.microsoft.com/devcontainers/typescript-node:24-bookworm"`) {
		t.Fatalf("expected merged config image to be preserved, got:\n%s", content)
	}
	if !strings.Contains(content, `"ghcr.io/devcontainers/features/go:1"`) {
		t.Fatalf("expected merged config features to be preserved, got:\n%s", content)
	}
	if !strings.Contains(content, `"postCreateCommand": "bash .devcontainer/post-create.sh"`) {
		t.Fatalf("expected lifecycle command keys to be normalized, got:\n%s", content)
	}
	if strings.Contains(content, `"postCreateCommands":`) {
		t.Fatalf("expected plural lifecycle command keys to be removed, got:\n%s", content)
	}
}

func TestWriteMountOverrideConfigRequiresRuntimeSource(t *testing.T) {
	mockBinDir := t.TempDir()
	mockDevcontainer := filepath.Join(mockBinDir, "devcontainer")
	mockScript := `#!/bin/sh
if [ "$1" = "read-configuration" ]; then
  echo '{"outcome":"success","mergedConfiguration":{"name":"Repo Config"}}'
  exit 0
fi
echo "unexpected devcontainer command: $@" >&2
exit 1
`
	if err := os.WriteFile(mockDevcontainer, []byte(mockScript), 0o755); err != nil {
		t.Fatalf("failed to write mock devcontainer command: %v", err)
	}
	origPath := os.Getenv("PATH")
	t.Setenv("PATH", mockBinDir+":"+origPath)

	cfg := &config.Config{
		WorkspaceDir: "/workspace/my-repo",
		Repository:   "owner/my-repo",
	}

	_, err := writeMountOverrideConfig(context.Background(), cfg, "sam-ws-abc123")
	if err == nil {
		t.Fatal("expected writeMountOverrideConfig to fail when runtime source is missing")
	}
	if !strings.Contains(err.Error(), "missing image/dockerFile/dockerComposeFile") {
		t.Fatalf("expected runtime source validation error, got: %v", err)
	}
}

func TestParseDevcontainerReadConfigurationOutput(t *testing.T) {
	t.Parallel()

	output := strings.Join([]string{
		`not-json-line`,
		`{"outcome":"success","mergedConfiguration":{"image":"node:20"}}`,
	}, "\n")

	parsed, err := parseDevcontainerReadConfigurationOutput(output)
	if err != nil {
		t.Fatalf("parseDevcontainerReadConfigurationOutput returned error: %v", err)
	}
	if parsed.Outcome != "success" {
		t.Fatalf("expected outcome success, got %q", parsed.Outcome)
	}
	if parsed.MergedConfiguration["image"] != "node:20" {
		t.Fatalf("expected mergedConfiguration.image=node:20, got %#v", parsed.MergedConfiguration["image"])
	}
}

func TestParseDevcontainerReadConfigurationOutputIgnoresUnrelatedJSONLogs(t *testing.T) {
	t.Parallel()

	output := strings.Join([]string{
		`{"level":"info","msg":"feature dependency resolved"}`,
		`{"outcome":"error","message":"stale internal state"}`,
		`{"outcome":"success","mergedConfiguration":{"image":"node:20"}}`,
		`{"level":"debug","msg":"cleanup complete"}`,
	}, "\n")

	parsed, err := parseDevcontainerReadConfigurationOutput(output)
	if err != nil {
		t.Fatalf("parseDevcontainerReadConfigurationOutput returned error: %v", err)
	}
	if parsed.Outcome != "success" {
		t.Fatalf("expected outcome success, got %q", parsed.Outcome)
	}
	if parsed.MergedConfiguration["image"] != "node:20" {
		t.Fatalf("expected mergedConfiguration.image=node:20, got %#v", parsed.MergedConfiguration["image"])
	}
}

func TestParseDevcontainerReadConfigurationOutputParsesMultilinePayload(t *testing.T) {
	t.Parallel()

	output := strings.Join([]string{
		`[2026-02-18T11:14:21.753Z] @devcontainers/cli 0.83.1`,
		`{`,
		`  "outcome": "success",`,
		`  "mergedConfiguration": {`,
		`    "dockerComposeFile": ["docker-compose.yml"]`,
		`  }`,
		`}`,
	}, "\n")

	parsed, err := parseDevcontainerReadConfigurationOutput(output)
	if err != nil {
		t.Fatalf("parseDevcontainerReadConfigurationOutput returned error: %v", err)
	}
	if parsed.Outcome != "success" {
		t.Fatalf("expected outcome success, got %q", parsed.Outcome)
	}
	value, ok := parsed.MergedConfiguration["dockerComposeFile"].([]interface{})
	if !ok || len(value) != 1 || value[0] != "docker-compose.yml" {
		t.Fatalf("expected mergedConfiguration.dockerComposeFile to contain docker-compose.yml, got %#v", parsed.MergedConfiguration["dockerComposeFile"])
	}
}

func TestEnsureContainerUserResolvedHonorsOverride(t *testing.T) {
	t.Parallel()

	cfg := &config.Config{ContainerUser: "custom-user"}
	ensureContainerUserResolved(context.Background(), cfg)
	if cfg.ContainerUser != "custom-user" {
		t.Fatalf("ContainerUser=%q, want %q", cfg.ContainerUser, "custom-user")
	}
}

func TestEnsureContainerUserResolvedUsesReadConfiguration(t *testing.T) {
	mockBinDir := t.TempDir()

	mockDevcontainer := filepath.Join(mockBinDir, "devcontainer")
	mockScript := `#!/bin/sh
if [ "$1" = "read-configuration" ]; then
  cat <<'EOF'
{"outcome":"success","mergedConfiguration":{"remoteUser":"node"}}
EOF
  exit 0
fi
echo "unexpected devcontainer command: $@" >&2
exit 1
`
	if err := os.WriteFile(mockDevcontainer, []byte(mockScript), 0o755); err != nil {
		t.Fatalf("failed to write mock devcontainer command: %v", err)
	}

	origPath := os.Getenv("PATH")
	t.Setenv("PATH", mockBinDir+":"+origPath)

	cfg := &config.Config{WorkspaceDir: t.TempDir()}
	ensureContainerUserResolved(context.Background(), cfg)

	if cfg.ContainerUser != "node" {
		t.Fatalf("ContainerUser=%q, want %q", cfg.ContainerUser, "node")
	}
}

func TestEnsureContainerUserResolvedFallsBackToMetadataLabel(t *testing.T) {
	mockBinDir := t.TempDir()

	mockDevcontainer := filepath.Join(mockBinDir, "devcontainer")
	mockDevcontainerScript := `#!/bin/sh
if [ "$1" = "read-configuration" ]; then
  echo "read-configuration failed" >&2
  exit 1
fi
exit 1
`
	if err := os.WriteFile(mockDevcontainer, []byte(mockDevcontainerScript), 0o755); err != nil {
		t.Fatalf("failed to write mock devcontainer command: %v", err)
	}

	mockDocker := filepath.Join(mockBinDir, "docker")
	mockDockerScript := `#!/bin/sh
if [ "$1" = "ps" ]; then
  echo "container-123"
  exit 0
fi
if [ "$1" = "inspect" ]; then
  echo '"[{\"remoteUser\":\"vscode\"}]"'
  exit 0
fi
exit 1
`
	if err := os.WriteFile(mockDocker, []byte(mockDockerScript), 0o755); err != nil {
		t.Fatalf("failed to write mock docker command: %v", err)
	}

	origPath := os.Getenv("PATH")
	t.Setenv("PATH", mockBinDir+":"+origPath)

	cfg := &config.Config{
		WorkspaceDir:        t.TempDir(),
		ContainerLabelKey:   "devcontainer.local_folder",
		ContainerLabelValue: "/workspace/ws-1",
	}
	ensureContainerUserResolved(context.Background(), cfg)

	if cfg.ContainerUser != "vscode" {
		t.Fatalf("ContainerUser=%q, want %q", cfg.ContainerUser, "vscode")
	}
}

func TestEnsureContainerUserResolvedFallsBackToDockerExec(t *testing.T) {
	mockBinDir := t.TempDir()

	mockDevcontainer := filepath.Join(mockBinDir, "devcontainer")
	mockDevcontainerScript := `#!/bin/sh
if [ "$1" = "read-configuration" ]; then
  echo "read-configuration failed" >&2
  exit 1
fi
exit 1
`
	if err := os.WriteFile(mockDevcontainer, []byte(mockDevcontainerScript), 0o755); err != nil {
		t.Fatalf("failed to write mock devcontainer command: %v", err)
	}

	mockDocker := filepath.Join(mockBinDir, "docker")
	mockDockerScript := `#!/bin/sh
if [ "$1" = "ps" ]; then
  echo "container-123"
  exit 0
fi
if [ "$1" = "inspect" ]; then
  echo null
  exit 0
fi
if [ "$1" = "exec" ]; then
  if [ "$3" = "id" ] && [ "$4" = "-un" ]; then
    echo "node"
    exit 0
  fi
fi
exit 1
`
	if err := os.WriteFile(mockDocker, []byte(mockDockerScript), 0o755); err != nil {
		t.Fatalf("failed to write mock docker command: %v", err)
	}

	origPath := os.Getenv("PATH")
	t.Setenv("PATH", mockBinDir+":"+origPath)

	cfg := &config.Config{
		WorkspaceDir:        t.TempDir(),
		ContainerLabelKey:   "devcontainer.local_folder",
		ContainerLabelValue: "/workspace/ws-1",
	}
	ensureContainerUserResolved(context.Background(), cfg)

	if cfg.ContainerUser != "node" {
		t.Fatalf("ContainerUser=%q, want %q", cfg.ContainerUser, "node")
	}
}

func TestEnsureWorkspaceOwnershipChownsWhenMismatch(t *testing.T) {
	mockBinDir := t.TempDir()
	chownLog := filepath.Join(t.TempDir(), "chown.log")

	mockDocker := filepath.Join(mockBinDir, "docker")
	mockDockerScript := `#!/bin/sh
if [ "$1" = "ps" ]; then
  echo "container-123"
  exit 0
fi
if [ "$1" = "exec" ]; then
  if [ "$2" = "-u" ] && [ "$3" = "root" ]; then
    if [ "$5" = "id" ] && [ "$6" = "-u" ] && [ "$7" = "node" ]; then
      echo "1000"
      exit 0
    fi
    if [ "$5" = "id" ] && [ "$6" = "-g" ] && [ "$7" = "node" ]; then
      echo "1000"
      exit 0
    fi
    if [ "$5" = "stat" ] && [ "$6" = "-c" ] && [ "$7" = "%u:%g" ]; then
      echo "0:0"
      exit 0
    fi
    if [ "$5" = "chown" ] && [ "$6" = "-R" ]; then
      echo "chown" >> "$MOCK_CHOWN_LOG"
      exit 0
    fi
  fi
fi
exit 1
`
	if err := os.WriteFile(mockDocker, []byte(mockDockerScript), 0o755); err != nil {
		t.Fatalf("failed to write mock docker command: %v", err)
	}

	origPath := os.Getenv("PATH")
	t.Setenv("PATH", mockBinDir+":"+origPath)
	t.Setenv("MOCK_CHOWN_LOG", chownLog)

	cfg := &config.Config{
		ContainerUser:       "node",
		ContainerLabelKey:   "devcontainer.local_folder",
		ContainerLabelValue: "/workspace/ws-1",
	}
	if err := ensureWorkspaceOwnership(context.Background(), cfg); err != nil {
		t.Fatalf("ensureWorkspaceOwnership returned error: %v", err)
	}
	if _, err := os.Stat(chownLog); err != nil {
		t.Fatalf("expected chown to run: %v", err)
	}
}

func TestEnsureWorkspaceOwnershipSkipsWhenAlreadyOwned(t *testing.T) {
	mockBinDir := t.TempDir()
	chownLog := filepath.Join(t.TempDir(), "chown.log")

	mockDocker := filepath.Join(mockBinDir, "docker")
	mockDockerScript := `#!/bin/sh
if [ "$1" = "ps" ]; then
  echo "container-123"
  exit 0
fi
if [ "$1" = "exec" ]; then
  if [ "$2" = "-u" ] && [ "$3" = "root" ]; then
    if [ "$5" = "id" ] && [ "$6" = "-u" ] && [ "$7" = "node" ]; then
      echo "1000"
      exit 0
    fi
    if [ "$5" = "id" ] && [ "$6" = "-g" ] && [ "$7" = "node" ]; then
      echo "1000"
      exit 0
    fi
    if [ "$5" = "stat" ] && [ "$6" = "-c" ] && [ "$7" = "%u:%g" ]; then
      echo "1000:1000"
      exit 0
    fi
    if [ "$5" = "chown" ] && [ "$6" = "-R" ]; then
      echo "chown" >> "$MOCK_CHOWN_LOG"
      exit 0
    fi
  fi
fi
exit 1
`
	if err := os.WriteFile(mockDocker, []byte(mockDockerScript), 0o755); err != nil {
		t.Fatalf("failed to write mock docker command: %v", err)
	}

	origPath := os.Getenv("PATH")
	t.Setenv("PATH", mockBinDir+":"+origPath)
	t.Setenv("MOCK_CHOWN_LOG", chownLog)

	cfg := &config.Config{
		ContainerUser:       "node",
		ContainerLabelKey:   "devcontainer.local_folder",
		ContainerLabelValue: "/workspace/ws-1",
	}
	if err := ensureWorkspaceOwnership(context.Background(), cfg); err != nil {
		t.Fatalf("ensureWorkspaceOwnership returned error: %v", err)
	}
	if _, err := os.Stat(chownLog); !os.IsNotExist(err) {
		t.Fatalf("expected chown to be skipped, got %v", err)
	}
}

func TestNormalizeMergedLifecycleCommands(t *testing.T) {
	t.Parallel()

	merged := map[string]interface{}{
		"onCreateCommands":      []interface{}{"echo oncreate"},
		"updateContentCommands": []interface{}{"echo update"},
		"postCreateCommands":    []interface{}{"echo postcreate"},
		"postStartCommands":     []interface{}{"echo poststart"},
		"postAttachCommands":    []interface{}{"echo postattach"},
	}

	normalizeMergedLifecycleCommands(merged)

	for plural, singular := range map[string]string{
		"onCreateCommands":      "onCreateCommand",
		"updateContentCommands": "updateContentCommand",
		"postCreateCommands":    "postCreateCommand",
		"postStartCommands":     "postStartCommand",
		"postAttachCommands":    "postAttachCommand",
	} {
		if _, ok := merged[plural]; ok {
			t.Fatalf("expected %s to be removed", plural)
		}
		if _, ok := merged[singular]; !ok {
			t.Fatalf("expected %s to be present", singular)
		}
	}

	if merged["postCreateCommand"] != "echo postcreate" {
		t.Fatalf("expected postCreateCommand to normalize to a single shell string, got %#v", merged["postCreateCommand"])
	}
}

func TestNormalizeLifecycleCommandValue(t *testing.T) {
	t.Parallel()

	got := normalizeLifecycleCommandValue([]interface{}{"echo one", "echo two"})
	if got != "echo one && echo two" {
		t.Fatalf("expected commands to join with &&, got %#v", got)
	}

	got = normalizeLifecycleCommandValue([]interface{}{"echo only"})
	if got != "echo only" {
		t.Fatalf("expected single command to remain a string, got %#v", got)
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
	readyStatus := ""

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/workspaces/"+workspaceID+"/ready" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}

		readyCalled = true
		readyAuth = r.Header.Get("Authorization")
		var payload struct {
			Status string `json:"status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("failed to decode ready payload: %v", err)
		}
		readyStatus = payload.Status
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

	recoveryMode, err := PrepareWorkspace(ctx, cfg, ProvisionState{}, nil)
	if err != nil {
		t.Fatalf("PrepareWorkspace returned error: %v", err)
	}

	if !readyCalled {
		t.Fatal("expected PrepareWorkspace to call the /ready callback")
	}
	if readyAuth != "Bearer "+callbackToken {
		t.Fatalf("unexpected ready callback auth header: got %q", readyAuth)
	}
	if readyStatus != workspaceReadyStatusRunning {
		t.Fatalf("expected ready status %q, got %q", workspaceReadyStatusRunning, readyStatus)
	}
	if recoveryMode {
		t.Fatal("expected recoveryMode=false when no build error marker exists")
	}
}

func TestPrepareWorkspaceMarksReadyAsRecoveryWhenFallbackIsUsed(t *testing.T) {
	mockBinDir := t.TempDir()
	mockDevcontainer := filepath.Join(mockBinDir, "devcontainer")
	mockScript := `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    --override-config) exit 0 ;;
  esac
done
echo "repo config failed" >&2
exit 1
`
	if err := os.WriteFile(mockDevcontainer, []byte(mockScript), 0o755); err != nil {
		t.Fatalf("failed to write mock devcontainer command: %v", err)
	}

	origPath := os.Getenv("PATH")
	t.Setenv("PATH", mockBinDir+":"+origPath)

	workspaceID := "ws-prepare-recovery"
	workspaceDir := t.TempDir()
	devcontainerDir := filepath.Join(workspaceDir, ".devcontainer")
	if err := os.MkdirAll(devcontainerDir, 0o755); err != nil {
		t.Fatalf("failed to create devcontainer dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(devcontainerDir, "devcontainer.json"), []byte(`{"image":"node:20"}`), 0o644); err != nil {
		t.Fatalf("failed to write devcontainer config: %v", err)
	}

	readyStatus := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/workspaces/"+workspaceID+"/ready" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var payload struct {
			Status string `json:"status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("failed to decode ready payload: %v", err)
		}
		readyStatus = payload.Status
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"recovery"}`))
	}))
	defer server.Close()

	cfg := &config.Config{
		WorkspaceID:                   workspaceID,
		ControlPlaneURL:               server.URL,
		CallbackToken:                 "cb-recovery",
		WorkspaceDir:                  workspaceDir,
		ContainerMode:                 false,
		DefaultDevcontainerConfigPath: filepath.Join(t.TempDir(), "default-devcontainer.json"),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	recoveryMode, err := PrepareWorkspace(ctx, cfg, ProvisionState{}, nil)
	if err != nil {
		t.Fatalf("PrepareWorkspace returned error: %v", err)
	}
	if !recoveryMode {
		t.Fatal("expected recoveryMode=true when fallback is used")
	}
	if readyStatus != workspaceReadyStatusRecovery {
		t.Fatalf("expected ready status %q, got %q", workspaceReadyStatusRecovery, readyStatus)
	}

	errorLogPath := filepath.Join(workspaceDir, buildErrorLogFilename)
	if _, err := os.Stat(errorLogPath); err != nil {
		t.Fatalf("expected recovery marker to be present after fallback: %v", err)
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

	_, err := PrepareWorkspace(ctx, cfg, ProvisionState{}, nil)
	if err == nil {
		t.Fatal("expected PrepareWorkspace to fail when /ready returns non-2xx")
	}
	if !strings.Contains(err.Error(), "ready endpoint returned HTTP 500") {
		t.Fatalf("expected ready endpoint error, got: %v", err)
	}
}

func TestPrepareWorkspaceReturnsFallbackFlag(t *testing.T) {
	// Mock devcontainer CLI that exits 0 (success, no fallback needed).
	mockBinDir := t.TempDir()
	mockDevcontainer := filepath.Join(mockBinDir, "devcontainer")
	if err := os.WriteFile(mockDevcontainer, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("failed to write mock devcontainer command: %v", err)
	}
	origPath := os.Getenv("PATH")
	t.Setenv("PATH", mockBinDir+":"+origPath)

	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/ready") {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer controlPlane.Close()

	cfg := &config.Config{
		ControlPlaneURL:               controlPlane.URL,
		WorkspaceID:                   "ws-fallback-test",
		CallbackToken:                 "cb-token",
		WorkspaceDir:                  t.TempDir(),
		ContainerMode:                 false,
		DefaultDevcontainerConfigPath: filepath.Join(t.TempDir(), "default-devcontainer.json"),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	usedFallback, err := PrepareWorkspace(ctx, cfg, ProvisionState{}, nil)
	if err != nil {
		t.Fatalf("PrepareWorkspace returned error: %v", err)
	}
	if usedFallback {
		t.Fatal("expected usedFallback=false when no fallback is needed")
	}
}

func TestEnsureDevcontainerReadyFallsBackOnRepoConfigFailure(t *testing.T) {
	// Mock devcontainer CLI that fails on first call (repo config)
	// but succeeds on second call (default config).
	mockBinDir := t.TempDir()

	// Also mock docker for stale container cleanup (removeStaleContainers calls docker ps -aq and docker rm -f)
	mockDocker := filepath.Join(mockBinDir, "docker")
	dockerScript := `#!/bin/sh
# Mock docker: ps -aq returns nothing (no stale containers), rm -f is a no-op
if [ "$1" = "ps" ]; then
  echo ""
  exit 0
fi
exit 0
`
	if err := os.WriteFile(mockDocker, []byte(dockerScript), 0o755); err != nil {
		t.Fatalf("failed to write mock docker command: %v", err)
	}

	mockDevcontainer := filepath.Join(mockBinDir, "devcontainer")
	// Script: first invocation fails if no --override-config flag, second (with --override-config) succeeds
	mockScript := `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    --override-config) exit 0 ;;
  esac
done
echo "Error: build failed" >&2
exit 1
`
	if err := os.WriteFile(mockDevcontainer, []byte(mockScript), 0o755); err != nil {
		t.Fatalf("failed to write mock devcontainer command: %v", err)
	}
	origPath := os.Getenv("PATH")
	t.Setenv("PATH", mockBinDir+":"+origPath)

	workspaceDir := t.TempDir()
	// Create a repo devcontainer config so hasDevcontainerConfig returns true
	devcontainerDir := filepath.Join(workspaceDir, ".devcontainer")
	os.MkdirAll(devcontainerDir, 0o755)
	os.WriteFile(filepath.Join(devcontainerDir, "devcontainer.json"), []byte(`{"image":"node:20"}`), 0o644)

	cfg := &config.Config{
		WorkspaceDir:                  workspaceDir,
		ContainerMode:                 true,
		ContainerLabelKey:             "devcontainer.local_folder",
		ContainerLabelValue:           workspaceDir,
		DefaultDevcontainerConfigPath: filepath.Join(t.TempDir(), "default-devcontainer.json"),
		DefaultDevcontainerImage:      "mcr.microsoft.com/devcontainers/base:ubuntu",
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	usedFallback, err := ensureDevcontainerReady(ctx, cfg, "")
	if err != nil {
		t.Fatalf("ensureDevcontainerReady returned error: %v", err)
	}
	if !usedFallback {
		t.Fatal("expected usedFallback=true when repo config fails and fallback succeeds")
	}

	// Verify the error log was written
	errorLogPath := filepath.Join(workspaceDir, ".devcontainer-build-error.log")
	if _, err := os.Stat(errorLogPath); os.IsNotExist(err) {
		t.Fatal("expected .devcontainer-build-error.log to exist")
	}

	// Verify the fallback config does NOT contain remoteUser (since DefaultDevcontainerRemoteUser is empty)
	fallbackConfig, err := os.ReadFile(cfg.DefaultDevcontainerConfigPath)
	if err != nil {
		t.Fatalf("failed to read fallback config: %v", err)
	}
	if strings.Contains(string(fallbackConfig), "remoteUser") {
		t.Fatalf("fallback config should not contain remoteUser, got:\n%s", string(fallbackConfig))
	}
}

func TestEnsureDevcontainerReadyAbortsFallbackWhenBuildLogsCannotBePersisted(t *testing.T) {
	mockBinDir := t.TempDir()
	devcontainerCalls := filepath.Join(t.TempDir(), "devcontainer-calls.log")

	mockDocker := filepath.Join(mockBinDir, "docker")
	dockerScript := `#!/bin/sh
if [ "$1" = "ps" ]; then
  echo ""
  exit 0
fi
if [ "$1" = "run" ]; then
  case "$@" in
    *"cat > /workspaces/.devcontainer-build-error.log"*)
      echo "failed to persist volume log" >&2
      exit 1
      ;;
  esac
  exit 0
fi
if [ "$1" = "rm" ]; then
  exit 0
fi
exit 0
`
	if err := os.WriteFile(mockDocker, []byte(dockerScript), 0o755); err != nil {
		t.Fatalf("failed to write mock docker command: %v", err)
	}

	mockDevcontainer := filepath.Join(mockBinDir, "devcontainer")
	mockScript := fmt.Sprintf(`#!/bin/sh
echo "$@" >> %s
if [ "$1" = "read-configuration" ]; then
  echo '{"outcome":"success","mergedConfiguration":{"image":"node:20"}}'
  exit 0
fi
if [ "$1" = "up" ]; then
  echo "repo build failed" >&2
  exit 1
fi
exit 0
`, devcontainerCalls)
	if err := os.WriteFile(mockDevcontainer, []byte(mockScript), 0o755); err != nil {
		t.Fatalf("failed to write mock devcontainer command: %v", err)
	}

	origPath := os.Getenv("PATH")
	t.Setenv("PATH", mockBinDir+":"+origPath)

	workspaceDir := t.TempDir()
	devcontainerDir := filepath.Join(workspaceDir, ".devcontainer")
	if err := os.MkdirAll(devcontainerDir, 0o755); err != nil {
		t.Fatalf("failed to create devcontainer dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(devcontainerDir, "devcontainer.json"), []byte(`{"image":"node:20"}`), 0o644); err != nil {
		t.Fatalf("failed to write devcontainer config: %v", err)
	}

	cfg := &config.Config{
		WorkspaceDir:                  workspaceDir,
		Repository:                    "owner/repo",
		ContainerMode:                 true,
		ContainerLabelKey:             "devcontainer.local_folder",
		ContainerLabelValue:           workspaceDir,
		DefaultDevcontainerConfigPath: filepath.Join(t.TempDir(), "default-devcontainer.json"),
		DefaultDevcontainerImage:      "mcr.microsoft.com/devcontainers/base:ubuntu",
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	usedFallback, err := ensureDevcontainerReady(ctx, cfg, "sam-ws-logfail")
	if err == nil {
		t.Fatal("expected ensureDevcontainerReady to fail when build logs cannot be persisted")
	}
	if usedFallback {
		t.Fatal("expected usedFallback=false when fallback is aborted")
	}
	if !strings.Contains(err.Error(), "aborting fallback") {
		t.Fatalf("expected aborting fallback error, got: %v", err)
	}

	errorLogPath := filepath.Join(workspaceDir, buildErrorLogFilename)
	logBytes, readErr := os.ReadFile(errorLogPath)
	if readErr != nil {
		t.Fatalf("expected host build log artifact to be written: %v", readErr)
	}
	if !strings.Contains(string(logBytes), "repo build failed") {
		t.Fatalf("expected host build log to contain repo build failure output, got:\n%s", string(logBytes))
	}

	callBytes, callErr := os.ReadFile(devcontainerCalls)
	if callErr != nil {
		t.Fatalf("failed to read devcontainer call log: %v", callErr)
	}
	upCalls := 0
	for _, line := range strings.Split(strings.TrimSpace(string(callBytes)), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "up ") {
			upCalls++
		}
	}
	if upCalls != 1 {
		t.Fatalf("expected exactly one devcontainer up attempt before fallback abort, got %d calls:\n%s", upCalls, string(callBytes))
	}
}

func TestRemoveStaleContainersCallsDockerCorrectly(t *testing.T) {
	// Cannot use t.Parallel() because t.Setenv modifies process environment.

	// Mock docker that records calls and returns a fake container ID
	mockBinDir := t.TempDir()
	callLog := filepath.Join(t.TempDir(), "docker-calls.log")

	mockDocker := filepath.Join(mockBinDir, "docker")
	dockerScript := fmt.Sprintf(`#!/bin/sh
echo "$@" >> %s
if [ "$1" = "ps" ]; then
  echo "abc123def456"
  exit 0
fi
exit 0
`, callLog)
	if err := os.WriteFile(mockDocker, []byte(dockerScript), 0o755); err != nil {
		t.Fatalf("failed to write mock docker command: %v", err)
	}
	origPath := os.Getenv("PATH")
	t.Setenv("PATH", mockBinDir+":"+origPath)

	cfg := &config.Config{
		ContainerLabelKey:   "devcontainer.local_folder",
		ContainerLabelValue: "/workspace/test-repo",
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	removeStaleContainers(ctx, cfg)

	// Read call log and verify docker was called correctly
	data, err := os.ReadFile(callLog)
	if err != nil {
		t.Fatalf("failed to read docker call log: %v", err)
	}
	calls := string(data)

	// Should have called docker ps -aq with filter
	if !strings.Contains(calls, "ps -aq --filter label=devcontainer.local_folder=/workspace/test-repo") {
		t.Fatalf("expected docker ps call with label filter, got:\n%s", calls)
	}

	// Should have called docker rm -f on the returned container ID
	if !strings.Contains(calls, "rm -f abc123def456") {
		t.Fatalf("expected docker rm -f abc123def456, got:\n%s", calls)
	}
}

func TestEnsureDevcontainerReadyNoFallbackWhenRepoConfigSucceeds(t *testing.T) {
	// Mock devcontainer CLI that always succeeds
	mockBinDir := t.TempDir()
	mockDevcontainer := filepath.Join(mockBinDir, "devcontainer")
	if err := os.WriteFile(mockDevcontainer, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("failed to write mock devcontainer command: %v", err)
	}
	origPath := os.Getenv("PATH")
	t.Setenv("PATH", mockBinDir+":"+origPath)

	workspaceDir := t.TempDir()
	// Create a repo devcontainer config
	devcontainerDir := filepath.Join(workspaceDir, ".devcontainer")
	os.MkdirAll(devcontainerDir, 0o755)
	os.WriteFile(filepath.Join(devcontainerDir, "devcontainer.json"), []byte(`{"image":"node:20"}`), 0o644)

	cfg := &config.Config{
		WorkspaceDir:                  workspaceDir,
		ContainerMode:                 true,
		ContainerLabelKey:             "devcontainer.local_folder",
		ContainerLabelValue:           workspaceDir,
		DefaultDevcontainerConfigPath: filepath.Join(t.TempDir(), "default-devcontainer.json"),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	usedFallback, err := ensureDevcontainerReady(ctx, cfg, "")
	if err != nil {
		t.Fatalf("ensureDevcontainerReady returned error: %v", err)
	}
	if usedFallback {
		t.Fatal("expected usedFallback=false when repo config succeeds")
	}
}
