package server

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

func TestParseWorktreeList(t *testing.T) {
	output := "worktree /workspaces/repo\nHEAD 0123456789abcdef\nbranch refs/heads/main\n\nworktree /workspaces/repo-wt-feature\nHEAD abcdef0123456789\nbranch refs/heads/feature/auth\n\nworktree /workspaces/repo-old\nHEAD fedcba9876543210\nprunable gitdir file points to non-existent location\n"
	items := parseWorktreeList(output, "/workspaces/repo")
	if len(items) != 3 {
		t.Fatalf("expected 3 worktrees, got %d", len(items))
	}
	if !items[0].IsPrimary {
		t.Fatalf("expected first worktree to be primary")
	}
	if items[0].Branch != "main" {
		t.Fatalf("expected main branch, got %q", items[0].Branch)
	}
	if items[1].Branch != "feature/auth" {
		t.Fatalf("expected feature/auth branch, got %q", items[1].Branch)
	}
	if !items[2].IsPrunable {
		t.Fatalf("expected prunable worktree to be flagged")
	}
}

func TestSanitizeBranchToDirectoryName(t *testing.T) {
	tests := []struct {
		name   string
		branch string
		want   string
	}{
		{name: "simple", branch: "feature-auth", want: "feature-auth"},
		{name: "slashes", branch: "feature/auth", want: "feature-auth"},
		{name: "spaces", branch: "feature auth", want: "feature-auth"},
		{name: "symbols", branch: "fix:#123", want: "fix-123"},
		{name: "empty", branch: "", want: "worktree"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sanitizeBranchToDirectoryName(tt.branch); got != tt.want {
				t.Fatalf("sanitizeBranchToDirectoryName(%q) = %q, want %q", tt.branch, got, tt.want)
			}
		})
	}
}

func TestValidateWorktreePathUsesCachedList(t *testing.T) {
	t.Parallel()

	s := &Server{
		config: &config.Config{
			WorktreeCacheTTL: 5 * time.Second,
		},
		worktreeCache: map[string]cachedWorktreeList{},
	}
	s.setCachedWorktrees("ws-1", []WorktreeInfo{
		{Path: "/workspaces/repo", Branch: "main", IsPrimary: true},
		{Path: "/workspaces/repo-wt-feature", Branch: "feature/auth"},
	})

	wt, err := s.validateWorktreePath(
		context.Background(),
		"ws-1",
		"container-1",
		"root",
		"/workspaces/repo",
		"/workspaces/repo-wt-feature",
	)
	if err != nil {
		t.Fatalf("validateWorktreePath() unexpected error: %v", err)
	}
	if wt == nil || wt.Path != "/workspaces/repo-wt-feature" {
		t.Fatalf("validateWorktreePath() returned %+v", wt)
	}
}

func TestValidateWorktreePathRejectsInvalidPaths(t *testing.T) {
	t.Parallel()

	s := &Server{
		config: &config.Config{
			WorktreeCacheTTL: 5 * time.Second,
		},
		worktreeCache: map[string]cachedWorktreeList{},
	}
	s.setCachedWorktrees("ws-1", []WorktreeInfo{
		{Path: "/workspaces/repo", Branch: "main", IsPrimary: true},
	})

	tests := []string{
		"",
		"../etc/passwd",
		"/tmp/not-allowed",
		"/workspaces/repo/../../etc",
		"/workspaces/does-not-exist",
	}
	for _, requested := range tests {
		_, err := s.validateWorktreePath(
			context.Background(),
			"ws-1",
			"container-1",
			"root",
			"/workspaces/repo",
			requested,
		)
		if err == nil {
			t.Fatalf("expected error for requested path %q", requested)
		}
	}
}

func TestResolveWorktreeWorkDir(t *testing.T) {
	t.Parallel()

	s := &Server{
		config: &config.Config{
			GitExecTimeout:   5 * time.Second,
			WorktreeCacheTTL: 5 * time.Second,
		},
		worktreeCache: map[string]cachedWorktreeList{},
	}
	s.setCachedWorktrees("ws-1", []WorktreeInfo{
		{Path: "/workspaces/repo", Branch: "main", IsPrimary: true},
		{Path: "/workspaces/repo-wt-feature", Branch: "feature/auth"},
	})

	noWorktreeReq := httptest.NewRequest("GET", "/workspaces/ws-1/git/status", nil)
	workDir, err := s.resolveWorktreeWorkDir(
		noWorktreeReq,
		"ws-1",
		"container-1",
		"root",
		"/workspaces/repo",
	)
	if err != nil {
		t.Fatalf("resolveWorktreeWorkDir() unexpected error without query param: %v", err)
	}
	if workDir != "/workspaces/repo" {
		t.Fatalf("resolveWorktreeWorkDir() = %q, want /workspaces/repo", workDir)
	}

	withWorktreeReq := httptest.NewRequest(
		"GET",
		"/workspaces/ws-1/git/status?worktree=/workspaces/repo-wt-feature",
		nil,
	)
	workDir, err = s.resolveWorktreeWorkDir(
		withWorktreeReq,
		"ws-1",
		"container-1",
		"root",
		"/workspaces/repo",
	)
	if err != nil {
		t.Fatalf("resolveWorktreeWorkDir() unexpected error with query param: %v", err)
	}
	if workDir != "/workspaces/repo-wt-feature" {
		t.Fatalf("resolveWorktreeWorkDir() = %q, want /workspaces/repo-wt-feature", workDir)
	}
}
