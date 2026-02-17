package server

import (
	"testing"
)

func TestParseWorktreePorcelain(t *testing.T) {
	input := `worktree /workspaces/my-repo
HEAD abc123def456789
branch refs/heads/main

worktree /workspaces/my-repo-wt-feature-auth
HEAD def456abc123789
branch refs/heads/feature/auth

worktree /workspaces/my-repo-wt-detached
HEAD 111222333444555
detached

`

	worktrees := ParseWorktreePorcelain(input)

	if len(worktrees) != 3 {
		t.Fatalf("expected 3 worktrees, got %d", len(worktrees))
	}

	// First worktree
	if worktrees[0].Path != "/workspaces/my-repo" {
		t.Errorf("worktree[0].Path = %q, want /workspaces/my-repo", worktrees[0].Path)
	}
	if worktrees[0].Branch != "main" {
		t.Errorf("worktree[0].Branch = %q, want main", worktrees[0].Branch)
	}
	if worktrees[0].HeadCommit != "abc123d" {
		t.Errorf("worktree[0].HeadCommit = %q, want abc123d", worktrees[0].HeadCommit)
	}

	// Second worktree
	if worktrees[1].Path != "/workspaces/my-repo-wt-feature-auth" {
		t.Errorf("worktree[1].Path = %q, want /workspaces/my-repo-wt-feature-auth", worktrees[1].Path)
	}
	if worktrees[1].Branch != "feature/auth" {
		t.Errorf("worktree[1].Branch = %q, want feature/auth", worktrees[1].Branch)
	}
	if worktrees[1].HeadCommit != "def456a" {
		t.Errorf("worktree[1].HeadCommit = %q, want def456a", worktrees[1].HeadCommit)
	}

	// Detached HEAD worktree
	if worktrees[2].Path != "/workspaces/my-repo-wt-detached" {
		t.Errorf("worktree[2].Path = %q, want /workspaces/my-repo-wt-detached", worktrees[2].Path)
	}
	if worktrees[2].Branch != "" {
		t.Errorf("worktree[2].Branch = %q, want empty (detached)", worktrees[2].Branch)
	}
}

func TestParseWorktreePorcelainEmpty(t *testing.T) {
	worktrees := ParseWorktreePorcelain("")
	if len(worktrees) != 0 {
		t.Fatalf("expected 0 worktrees, got %d", len(worktrees))
	}
}

func TestParseWorktreePorcelainNoTrailingNewline(t *testing.T) {
	input := `worktree /workspaces/my-repo
HEAD abc123def456789
branch refs/heads/main`

	worktrees := ParseWorktreePorcelain(input)
	if len(worktrees) != 1 {
		t.Fatalf("expected 1 worktree, got %d", len(worktrees))
	}
	if worktrees[0].Path != "/workspaces/my-repo" {
		t.Errorf("worktree[0].Path = %q, want /workspaces/my-repo", worktrees[0].Path)
	}
}

func TestValidateWorktreePathFormat(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		wantErr bool
	}{
		{name: "valid path", path: "/workspaces/my-repo-wt-feature", wantErr: false},
		{name: "primary worktree", path: "/workspaces/my-repo", wantErr: false},
		{name: "empty path", path: "", wantErr: true},
		{name: "not under workspaces", path: "/home/user/repo", wantErr: true},
		{name: "path traversal", path: "/workspaces/../etc/passwd", wantErr: true},
		{name: "bare workspaces dir", path: "/workspaces/", wantErr: true},
		{name: "null byte", path: "/workspaces/my-repo\x00evil", wantErr: true},
		{name: "just workspaces", path: "/workspaces", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateWorktreePathFormat(tt.path)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateWorktreePathFormat(%q) error = %v, wantErr %v", tt.path, err, tt.wantErr)
			}
		})
	}
}

func TestSanitizeWorktreeDirName(t *testing.T) {
	tests := []struct {
		name        string
		repoDirName string
		branch      string
		want        string
	}{
		{
			name:        "simple branch",
			repoDirName: "my-repo",
			branch:      "feature-auth",
			want:        "my-repo-wt-feature-auth",
		},
		{
			name:        "branch with slashes",
			repoDirName: "my-repo",
			branch:      "feature/auth/login",
			want:        "my-repo-wt-feature-auth-login",
		},
		{
			name:        "branch with uppercase",
			repoDirName: "my-repo",
			branch:      "Feature/Auth",
			want:        "my-repo-wt-feature-auth",
		},
		{
			name:        "branch with special chars",
			repoDirName: "my-repo",
			branch:      "bugfix@42!",
			want:        "my-repo-wt-bugfix-42-",
		},
		{
			name:        "very long branch name",
			repoDirName: "my-repo",
			branch:      "feature/this-is-a-very-long-branch-name-that-exceeds-the-fifty-character-limit",
			want:        "my-repo-wt-feature-this-is-a-very-long-branch-name",
		},
		{
			name:        "empty branch",
			repoDirName: "my-repo",
			branch:      "",
			want:        "my-repo-wt-worktree",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SanitizeWorktreeDirName(tt.repoDirName, tt.branch)
			if got != tt.want {
				t.Errorf("SanitizeWorktreeDirName(%q, %q) = %q, want %q", tt.repoDirName, tt.branch, got, tt.want)
			}
		})
	}
}
