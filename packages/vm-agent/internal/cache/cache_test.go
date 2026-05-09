package cache

import (
	"testing"
)

func TestParseGitHubRepo(t *testing.T) {
	tests := []struct {
		name      string
		repoURL   string
		wantOwner string
		wantRepo  string
		wantOK    bool
	}{
		{
			name:      "https URL",
			repoURL:   "https://github.com/octocat/hello-world.git",
			wantOwner: "octocat",
			wantRepo:  "hello-world",
			wantOK:    true,
		},
		{
			name:      "https URL without .git",
			repoURL:   "https://github.com/octocat/hello-world",
			wantOwner: "octocat",
			wantRepo:  "hello-world",
			wantOK:    true,
		},
		{
			name:      "SSH URL",
			repoURL:   "git@github.com:octocat/hello-world.git",
			wantOwner: "octocat",
			wantRepo:  "hello-world",
			wantOK:    true,
		},
		{
			name:      "SSH URL without .git",
			repoURL:   "git@github.com:octocat/hello-world",
			wantOwner: "octocat",
			wantRepo:  "hello-world",
			wantOK:    true,
		},
		{
			name:      "bare owner/repo",
			repoURL:   "octocat/hello-world",
			wantOwner: "octocat",
			wantRepo:  "hello-world",
			wantOK:    true,
		},
		{
			name:   "non-GitHub HTTPS URL",
			repoURL: "https://gitlab.com/octocat/hello-world.git",
			wantOK: false,
		},
		{
			name:   "empty string",
			repoURL: "",
			wantOK: false,
		},
		{
			name:   "whitespace only",
			repoURL: "   ",
			wantOK: false,
		},
		{
			name:   "single segment",
			repoURL: "hello-world",
			wantOK: false,
		},
		{
			name:   "empty owner",
			repoURL: "/hello-world",
			wantOK: false,
		},
		{
			name:   "empty repo",
			repoURL: "octocat/",
			wantOK: false,
		},
		{
			name:      "https URL with trailing slash",
			repoURL:   "https://github.com/octocat/hello-world/",
			wantOwner: "octocat",
			wantRepo:  "hello-world",
			wantOK:    true,
		},
		{
			name:      "owner/repo with extra segments ignored",
			repoURL:   "https://github.com/octocat/hello-world/tree/main",
			wantOwner: "octocat",
			wantRepo:  "hello-world",
			wantOK:    true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			owner, repo, ok := ParseGitHubRepo(tt.repoURL)
			if ok != tt.wantOK {
				t.Errorf("ParseGitHubRepo(%q) ok = %v, want %v", tt.repoURL, ok, tt.wantOK)
				return
			}
			if !ok {
				return
			}
			if owner != tt.wantOwner {
				t.Errorf("ParseGitHubRepo(%q) owner = %q, want %q", tt.repoURL, owner, tt.wantOwner)
			}
			if repo != tt.wantRepo {
				t.Errorf("ParseGitHubRepo(%q) repo = %q, want %q", tt.repoURL, repo, tt.wantRepo)
			}
		})
	}
}

func TestCacheRef(t *testing.T) {
	tests := []struct {
		name       string
		registry   string
		owner      string
		repo       string
		configName string
		want       string
	}{
		{
			name:     "default config",
			registry: "ghcr.io",
			owner:    "octocat",
			repo:     "hello-world",
			want:     "ghcr.io/octocat/hello-world:devcontainer-cache",
		},
		{
			name:       "named config",
			registry:   "ghcr.io",
			owner:      "octocat",
			repo:       "hello-world",
			configName: "python",
			want:       "ghcr.io/octocat/hello-world:devcontainer-cache-python",
		},
		{
			name:     "uppercase owner normalized",
			registry: "ghcr.io",
			owner:    "OctoCat",
			repo:     "Hello-World",
			want:     "ghcr.io/octocat/hello-world:devcontainer-cache",
		},
		{
			name:     "custom registry",
			registry: "registry.example.com",
			owner:    "myorg",
			repo:     "myapp",
			want:     "registry.example.com/myorg/myapp:devcontainer-cache",
		},
		{
			name:       "config name with spaces sanitized",
			registry:   "ghcr.io",
			owner:      "octocat",
			repo:       "hello-world",
			configName: "my config",
			want:       "ghcr.io/octocat/hello-world:devcontainer-cache-my-config",
		},
		{
			name:       "config name with colon sanitized",
			registry:   "ghcr.io",
			owner:      "octocat",
			repo:       "hello-world",
			configName: "node:20",
			want:       "ghcr.io/octocat/hello-world:devcontainer-cache-node-20",
		},
		{
			name:       "config name with special chars sanitized",
			registry:   "ghcr.io",
			owner:      "octocat",
			repo:       "hello-world",
			configName: "@my/config+v2",
			want:       "ghcr.io/octocat/hello-world:devcontainer-cache-my-config-v2",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CacheRef(tt.registry, tt.owner, tt.repo, tt.configName)
			if got != tt.want {
				t.Errorf("CacheRef(%q, %q, %q, %q) = %q, want %q",
					tt.registry, tt.owner, tt.repo, tt.configName, got, tt.want)
			}
		})
	}
}
