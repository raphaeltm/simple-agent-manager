package server

import (
	"testing"
)

func TestWorkspaceDefaultBranch(t *testing.T) {
	t.Parallel()

	s := &Server{
		workspaces: map[string]*WorkspaceRuntime{
			"ws-branch-only":    {ID: "ws-branch-only", Branch: "main"},
			"ws-default-set":    {ID: "ws-default-set", Branch: "sam/task-123", DefaultBranch: "main"},
			"ws-same":           {ID: "ws-same", Branch: "main", DefaultBranch: "main"},
			"ws-empty-default":  {ID: "ws-empty-default", Branch: "develop", DefaultBranch: ""},
			"ws-empty-both":     {ID: "ws-empty-both", Branch: "", DefaultBranch: ""},
		},
	}

	tests := []struct {
		name        string
		workspaceID string
		want        string
	}{
		{name: "fallback to Branch when DefaultBranch empty", workspaceID: "ws-branch-only", want: "main"},
		{name: "DefaultBranch takes precedence over Branch", workspaceID: "ws-default-set", want: "main"},
		{name: "DefaultBranch same as Branch", workspaceID: "ws-same", want: "main"},
		{name: "empty DefaultBranch falls back to Branch", workspaceID: "ws-empty-default", want: "develop"},
		{name: "both empty returns empty", workspaceID: "ws-empty-both", want: ""},
		{name: "unknown workspace returns empty", workspaceID: "ws-unknown", want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := s.workspaceDefaultBranch(tt.workspaceID)
			if got != tt.want {
				t.Errorf("workspaceDefaultBranch(%q) = %q, want %q", tt.workspaceID, got, tt.want)
			}
		})
	}
}

// TestShouldBlockDefaultBranchPush exercises the extracted predicate that
// gitPushWorkspaceChanges calls to decide whether to block a push. This tests
// the real production predicate, not a re-derived copy of the logic.
func TestShouldBlockDefaultBranchPush(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name           string
		checkoutBranch string // the project default branch
		currentBranch  string // HEAD branch from git rev-parse
		wantBlocked    bool
	}{
		{
			name:           "HEAD on default branch main — should block",
			checkoutBranch: "main",
			currentBranch:  "main",
			wantBlocked:    true,
		},
		{
			name:           "HEAD on default branch master — should block",
			checkoutBranch: "master",
			currentBranch:  "master",
			wantBlocked:    true,
		},
		{
			name:           "HEAD on task output branch — should allow",
			checkoutBranch: "main",
			currentBranch:  "sam/fix-something-abc123",
			wantBlocked:    false,
		},
		{
			name:           "HEAD on feature branch — should allow",
			checkoutBranch: "main",
			currentBranch:  "feature/my-feature",
			wantBlocked:    false,
		},
		{
			name:           "empty checkout branch (unknown workspace) — should allow",
			checkoutBranch: "",
			currentBranch:  "main",
			wantBlocked:    false,
		},
		{
			name:           "non-standard default branch develop — should block",
			checkoutBranch: "develop",
			currentBranch:  "develop",
			wantBlocked:    true,
		},
		{
			name:           "non-standard default branch production — should block",
			checkoutBranch: "production",
			currentBranch:  "production",
			wantBlocked:    true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := shouldBlockDefaultBranchPush(tt.checkoutBranch, tt.currentBranch)
			if got != tt.wantBlocked {
				t.Errorf("shouldBlockDefaultBranchPush(%q, %q) = %v, want %v",
					tt.checkoutBranch, tt.currentBranch, got, tt.wantBlocked)
			}
		})
	}
}

// TestGitPushGuardIntegration verifies the guard using a real Server struct
// with workspace state, exercising both workspaceDefaultBranch and
// shouldBlockDefaultBranchPush together as they would be called in
// gitPushWorkspaceChanges.
func TestGitPushGuardIntegration(t *testing.T) {
	t.Parallel()

	s := &Server{
		workspaces: map[string]*WorkspaceRuntime{
			"ws-main":    {ID: "ws-main", Branch: "main"},
			"ws-master":  {ID: "ws-master", Branch: "master"},
			"ws-develop": {ID: "ws-develop", Branch: "develop"},
		},
	}

	tests := []struct {
		name          string
		workspaceID   string
		currentBranch string
		wantBlocked   bool
	}{
		{
			name:          "workspace on main, HEAD on main — blocked",
			workspaceID:   "ws-main",
			currentBranch: "main",
			wantBlocked:   true,
		},
		{
			name:          "workspace on main, HEAD on output branch — allowed",
			workspaceID:   "ws-main",
			currentBranch: "sam/fix-bug-abc123",
			wantBlocked:   false,
		},
		{
			name:          "workspace on master, HEAD on master — blocked",
			workspaceID:   "ws-master",
			currentBranch: "master",
			wantBlocked:   true,
		},
		{
			name:          "workspace on master, HEAD on feature — allowed",
			workspaceID:   "ws-master",
			currentBranch: "feature/new-thing",
			wantBlocked:   false,
		},
		{
			name:          "workspace on develop, HEAD on develop — blocked",
			workspaceID:   "ws-develop",
			currentBranch: "develop",
			wantBlocked:   true,
		},
		{
			name:          "workspace on develop, HEAD on task branch — allowed",
			workspaceID:   "ws-develop",
			currentBranch: "sam/task-123",
			wantBlocked:   false,
		},
		{
			name:          "unknown workspace — guard skipped (allowed)",
			workspaceID:   "ws-unknown",
			currentBranch: "main",
			wantBlocked:   false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			defaultBranch := s.workspaceDefaultBranch(tt.workspaceID)
			blocked := shouldBlockDefaultBranchPush(defaultBranch, tt.currentBranch)
			if blocked != tt.wantBlocked {
				t.Errorf("guard(workspace=%q, HEAD=%q) blocked=%v, want %v (defaultBranch=%q)",
					tt.workspaceID, tt.currentBranch, blocked, tt.wantBlocked, defaultBranch)
			}
		})
	}
}

// TestGitPushGuardWithDefaultBranch verifies the critical scenario where
// DefaultBranch differs from Branch — the dispatch/retry case where the
// workspace is checked out on the task output branch directly but the project
// default branch is different. The guard must compare against DefaultBranch
// (the project default), not Branch (the checkout branch).
func TestGitPushGuardWithDefaultBranch(t *testing.T) {
	t.Parallel()

	s := &Server{
		workspaces: map[string]*WorkspaceRuntime{
			// Dispatch/retry scenario: workspace checks out the output branch directly.
			// Branch="sam/task-123" (what was checked out), DefaultBranch="main" (project default).
			"ws-dispatch": {
				ID:            "ws-dispatch",
				Branch:        "sam/task-123",
				DefaultBranch: "main",
			},
			// Legacy/backwards-compat: no DefaultBranch set, falls back to Branch.
			"ws-legacy": {
				ID:     "ws-legacy",
				Branch: "main",
			},
			// Edge case: both set to same value.
			"ws-same-default": {
				ID:            "ws-same-default",
				Branch:        "main",
				DefaultBranch: "main",
			},
		},
	}

	tests := []struct {
		name          string
		workspaceID   string
		currentBranch string
		wantBlocked   bool
	}{
		{
			name:          "dispatch: HEAD on output branch (same as Branch) — NOT blocked (agent is on correct branch)",
			workspaceID:   "ws-dispatch",
			currentBranch: "sam/task-123",
			wantBlocked:   false,
		},
		{
			name:          "dispatch: HEAD on default branch main — blocked (agent failed to stay on output branch)",
			workspaceID:   "ws-dispatch",
			currentBranch: "main",
			wantBlocked:   true,
		},
		{
			name:          "dispatch: HEAD on unrelated feature branch — allowed",
			workspaceID:   "ws-dispatch",
			currentBranch: "feature/something-else",
			wantBlocked:   false,
		},
		{
			name:          "legacy: HEAD on main (no DefaultBranch set) — blocked via Branch fallback",
			workspaceID:   "ws-legacy",
			currentBranch: "main",
			wantBlocked:   true,
		},
		{
			name:          "legacy: HEAD on task branch — allowed",
			workspaceID:   "ws-legacy",
			currentBranch: "sam/task-456",
			wantBlocked:   false,
		},
		{
			name:          "same default: HEAD on main — blocked",
			workspaceID:   "ws-same-default",
			currentBranch: "main",
			wantBlocked:   true,
		},
		{
			name:          "same default: HEAD on output branch — allowed",
			workspaceID:   "ws-same-default",
			currentBranch: "sam/task-789",
			wantBlocked:   false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			defaultBranch := s.workspaceDefaultBranch(tt.workspaceID)
			blocked := shouldBlockDefaultBranchPush(defaultBranch, tt.currentBranch)
			if blocked != tt.wantBlocked {
				t.Errorf("guard(workspace=%q, HEAD=%q) blocked=%v, want %v (resolvedDefaultBranch=%q)",
					tt.workspaceID, tt.currentBranch, blocked, tt.wantBlocked, defaultBranch)
			}
		})
	}
}
