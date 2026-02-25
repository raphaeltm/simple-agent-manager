package config

import (
	"path/filepath"
	"testing"
	"time"
)

func TestDeriveRepoDirName(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "owner/repo", in: "octo/repo", want: "repo"},
		{name: "github url with dot git", in: "https://github.com/octo/repo.git", want: "repo"},
		{name: "github url without dot git", in: "https://github.com/octo/repo", want: "repo"},
		{name: "path with trailing slash", in: "octo/repo/", want: "repo"},
		{name: "empty", in: "", want: ""},
		{name: "weird chars", in: "octo/my repo!", want: "my-repo"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := DeriveRepoDirName(tc.in)
			if got != tc.want {
				t.Fatalf("deriveRepoDirName(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestDeriveWorkspaceDir(t *testing.T) {
	t.Parallel()

	base := "/workspace"
	if got := deriveWorkspaceDir(base, "octo/repo"); got != filepath.Join(base, "repo") {
		t.Fatalf("unexpected workspace dir: %s", got)
	}
	if got := deriveWorkspaceDir(base, ""); got != base {
		t.Fatalf("expected base dir when repo empty, got: %s", got)
	}
}

func TestDeriveContainerWorkDir(t *testing.T) {
	t.Parallel()

	if got := deriveContainerWorkDir("/workspace/repo"); got != "/workspaces/repo" {
		t.Fatalf("deriveContainerWorkDir returned %q", got)
	}
	if got := deriveContainerWorkDir("/workspace"); got != "/workspaces/workspace" {
		t.Fatalf("deriveContainerWorkDir returned %q", got)
	}
	if got := deriveContainerWorkDir(""); got != "/workspaces" {
		t.Fatalf("deriveContainerWorkDir returned %q", got)
	}
}

func TestLoadDerivesWorkspaceAndContainerDefaults(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("REPOSITORY", "octo/repo")
	t.Setenv("WORKSPACE_BASE_DIR", "/workspace")
	t.Setenv("WORKSPACE_DIR", "")
	t.Setenv("CONTAINER_LABEL_VALUE", "")
	t.Setenv("CONTAINER_WORK_DIR", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}

	if cfg.WorkspaceDir != "/workspace/repo" {
		t.Fatalf("WorkspaceDir=%q, want %q", cfg.WorkspaceDir, "/workspace/repo")
	}
	if cfg.ContainerLabelValue != "/workspace/repo" {
		t.Fatalf("ContainerLabelValue=%q, want %q", cfg.ContainerLabelValue, "/workspace/repo")
	}
	if cfg.ContainerWorkDir != "/workspaces/repo" {
		t.Fatalf("ContainerWorkDir=%q, want %q", cfg.ContainerWorkDir, "/workspaces/repo")
	}
}

func TestAdditionalFeaturesDefault(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.AdditionalFeatures != DefaultAdditionalFeatures {
		t.Fatalf("AdditionalFeatures=%q, want default %q", cfg.AdditionalFeatures, DefaultAdditionalFeatures)
	}
}

func TestAdditionalFeaturesOverride(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("ADDITIONAL_FEATURES", `{"custom/feature:1":{}}`)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.AdditionalFeatures != `{"custom/feature:1":{}}` {
		t.Fatalf("AdditionalFeatures=%q, want custom override", cfg.AdditionalFeatures)
	}
}

func TestLoadDefaultsContainerUserEmpty(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.ContainerUser != "" {
		t.Fatalf("ContainerUser=%q, want empty string", cfg.ContainerUser)
	}
}

func TestBootstrapTimeoutDefault(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.BootstrapTimeout != 15*time.Minute {
		t.Fatalf("BootstrapTimeout=%v, want %v", cfg.BootstrapTimeout, 15*time.Minute)
	}
}

func TestBootstrapTimeoutOverride(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("BOOTSTRAP_TIMEOUT", "20m")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.BootstrapTimeout != 20*time.Minute {
		t.Fatalf("BootstrapTimeout=%v, want %v", cfg.BootstrapTimeout, 20*time.Minute)
	}
}

func TestPTYOrphanGracePeriodDefaultDisabled(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.PTYOrphanGracePeriod != 0 {
		t.Fatalf("PTYOrphanGracePeriod=%v, want 0", cfg.PTYOrphanGracePeriod)
	}
}

func TestPTYOrphanGracePeriodOverride(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("PTY_ORPHAN_GRACE_PERIOD", "300")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.PTYOrphanGracePeriod != 5*time.Minute {
		t.Fatalf("PTYOrphanGracePeriod=%v, want %v", cfg.PTYOrphanGracePeriod, 5*time.Minute)
	}
}

func TestDeriveBaseDomain(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		url  string
		want string
	}{
		{name: "api subdomain https", url: "https://api.example.com", want: "example.com"},
		{name: "api subdomain with path", url: "https://api.example.com/foo/bar", want: "example.com"},
		{name: "api subdomain with port", url: "https://api.example.com:8080", want: "example.com"},
		{name: "no api prefix", url: "https://example.com", want: "example.com"},
		{name: "http scheme", url: "http://api.localhost", want: "localhost"},
		{name: "bare host", url: "api.example.com", want: "example.com"},
		{name: "nested subdomain", url: "https://api.staging.example.com", want: "staging.example.com"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := DeriveBaseDomain(tc.url); got != tc.want {
				t.Fatalf("DeriveBaseDomain(%q) = %q, want %q", tc.url, got, tc.want)
			}
		})
	}
}

func TestBuildSAMEnvFallback(t *testing.T) {
	t.Parallel()

	cfg := &Config{
		ControlPlaneURL: "https://api.example.com",
		WorkspaceID:     "ws-123",
		NodeID:          "node-456",
		Repository:      "octo/repo",
		Branch:          "main",
		ProjectID:       "proj-789",
		ChatSessionID:   "session-abc",
		TaskID:          "task-def",
	}

	fallback := cfg.BuildSAMEnvFallback()

	want := map[string]string{
		"SAM_API_URL":         "https://api.example.com",
		"SAM_BRANCH":          "main",
		"SAM_NODE_ID":         "node-456",
		"SAM_PROJECT_ID":      "proj-789",
		"SAM_CHAT_SESSION_ID": "session-abc",
		"SAM_TASK_ID":         "task-def",
		"SAM_REPOSITORY":      "octo/repo",
		"SAM_WORKSPACE_ID":    "ws-123",
		"SAM_WORKSPACE_URL":   "https://ws-ws-123.example.com",
	}

	got := make(map[string]string)
	for _, entry := range fallback {
		parts := splitFirst(entry, "=")
		if len(parts) == 2 {
			got[parts[0]] = parts[1]
		}
	}

	for key, wantVal := range want {
		if gotVal, ok := got[key]; !ok {
			t.Errorf("fallback missing key %s", key)
		} else if gotVal != wantVal {
			t.Errorf("fallback[%s] = %q, want %q", key, gotVal, wantVal)
		}
	}
}

func TestBuildSAMEnvFallbackOmitsEmptyValues(t *testing.T) {
	t.Parallel()

	cfg := &Config{
		ControlPlaneURL: "https://api.example.com",
		WorkspaceID:     "ws-123",
		// ProjectID, ChatSessionID, TaskID left empty
	}

	fallback := cfg.BuildSAMEnvFallback()

	for _, entry := range fallback {
		parts := splitFirst(entry, "=")
		if len(parts) == 2 {
			switch parts[0] {
			case "SAM_PROJECT_ID", "SAM_CHAT_SESSION_ID", "SAM_TASK_ID":
				t.Errorf("fallback should not contain %s when empty", parts[0])
			}
		}
	}
}

// splitFirst splits s on the first occurrence of sep.
func splitFirst(s, sep string) []string {
	idx := len(sep)
	for i := 0; i <= len(s)-len(sep); i++ {
		if s[i:i+len(sep)] == sep {
			return []string{s[:i], s[i+idx:]}
		}
	}
	return []string{s}
}
