package server

import (
	"testing"
)

func TestWorkspaceCheckoutBranch(t *testing.T) {
	t.Parallel()

	s := &Server{
		workspaces: map[string]*WorkspaceRuntime{
			"ws-1": {ID: "ws-1", Branch: "main"},
			"ws-2": {ID: "ws-2", Branch: "master"},
			"ws-3": {ID: "ws-3", Branch: "develop"},
			"ws-4": {ID: "ws-4", Branch: ""},
		},
	}

	tests := []struct {
		name        string
		workspaceID string
		want        string
	}{
		{name: "main branch", workspaceID: "ws-1", want: "main"},
		{name: "master branch", workspaceID: "ws-2", want: "master"},
		{name: "develop branch", workspaceID: "ws-3", want: "develop"},
		{name: "empty branch", workspaceID: "ws-4", want: ""},
		{name: "unknown workspace", workspaceID: "ws-unknown", want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := s.workspaceCheckoutBranch(tt.workspaceID)
			if got != tt.want {
				t.Errorf("workspaceCheckoutBranch(%q) = %q, want %q", tt.workspaceID, got, tt.want)
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
		checkoutBranch string // the branch the workspace was created with (project default)
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
// with workspace state, exercising both workspaceCheckoutBranch and
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
			checkoutBranch := s.workspaceCheckoutBranch(tt.workspaceID)
			blocked := shouldBlockDefaultBranchPush(checkoutBranch, tt.currentBranch)
			if blocked != tt.wantBlocked {
				t.Errorf("guard(workspace=%q, HEAD=%q) blocked=%v, want %v (checkoutBranch=%q)",
					tt.workspaceID, tt.currentBranch, blocked, tt.wantBlocked, checkoutBranch)
			}
		})
	}
}
