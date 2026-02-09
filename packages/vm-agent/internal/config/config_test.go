package config

import (
	"path/filepath"
	"testing"
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
			got := deriveRepoDirName(tc.in)
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
