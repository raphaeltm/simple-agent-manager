package server

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
)

// WorktreeInfo represents a git worktree within a workspace.
type WorktreeInfo struct {
	Path           string `json:"path"`
	Branch         string `json:"branch"`
	HeadCommit     string `json:"headCommit"`
	IsPrimary      bool   `json:"isPrimary"`
	IsDirty        bool   `json:"isDirty"`
	DirtyFileCount int    `json:"dirtyFileCount"`
}

// worktreeCacheEntry holds a cached list of worktrees for a workspace.
type worktreeCacheEntry struct {
	worktrees []WorktreeInfo
	expiresAt time.Time
}

// WorktreeValidator validates and caches worktree paths per workspace.
type WorktreeValidator struct {
	mu       sync.RWMutex
	cache    map[string]*worktreeCacheEntry
	cacheTTL time.Duration
}

// NewWorktreeValidator creates a new validator with the given cache TTL.
func NewWorktreeValidator(cacheTTL time.Duration) *WorktreeValidator {
	return &WorktreeValidator{
		cache:    make(map[string]*worktreeCacheEntry),
		cacheTTL: cacheTTL,
	}
}

// execFunc is the function signature for executing commands in a container.
type execFunc func(ctx context.Context, containerID, user, workDir string, args ...string) (stdout string, stderr string, err error)

// ListWorktrees returns all worktrees for a workspace. Uses cache if fresh.
// The execFn, containerID, user, and primaryWorkDir parameters are used to run
// git commands inside the devcontainer.
func (v *WorktreeValidator) ListWorktrees(
	ctx context.Context,
	workspaceID string,
	execFn execFunc,
	containerID, user, primaryWorkDir string,
) ([]WorktreeInfo, error) {
	// Check cache
	v.mu.RLock()
	if entry, ok := v.cache[workspaceID]; ok && time.Now().Before(entry.expiresAt) {
		result := make([]WorktreeInfo, len(entry.worktrees))
		copy(result, entry.worktrees)
		v.mu.RUnlock()
		return result, nil
	}
	v.mu.RUnlock()

	// Cache miss — fetch from git
	worktrees, err := v.fetchWorktrees(ctx, execFn, containerID, user, primaryWorkDir)
	if err != nil {
		return nil, err
	}

	// Update cache
	v.mu.Lock()
	v.cache[workspaceID] = &worktreeCacheEntry{
		worktrees: worktrees,
		expiresAt: time.Now().Add(v.cacheTTL),
	}
	v.mu.Unlock()

	result := make([]WorktreeInfo, len(worktrees))
	copy(result, worktrees)
	return result, nil
}

// ValidateWorktreePath checks if a path is a valid worktree for the workspace.
// Returns the matching WorktreeInfo or an error.
func (v *WorktreeValidator) ValidateWorktreePath(
	ctx context.Context,
	workspaceID string,
	path string,
	execFn execFunc,
	containerID, user, primaryWorkDir string,
) (*WorktreeInfo, error) {
	if err := validateWorktreePathFormat(path); err != nil {
		return nil, err
	}

	worktrees, err := v.ListWorktrees(ctx, workspaceID, execFn, containerID, user, primaryWorkDir)
	if err != nil {
		return nil, fmt.Errorf("failed to list worktrees: %w", err)
	}

	for i := range worktrees {
		if worktrees[i].Path == path {
			return &worktrees[i], nil
		}
	}

	return nil, fmt.Errorf("path is not a valid worktree for this workspace")
}

// InvalidateCache removes the cached worktree list for a workspace.
func (v *WorktreeValidator) InvalidateCache(workspaceID string) {
	v.mu.Lock()
	delete(v.cache, workspaceID)
	v.mu.Unlock()
}

// fetchWorktrees runs git worktree list --porcelain and parses the output.
func (v *WorktreeValidator) fetchWorktrees(
	ctx context.Context,
	execFn execFunc,
	containerID, user, primaryWorkDir string,
) ([]WorktreeInfo, error) {
	stdout, _, err := execFn(ctx, containerID, user, primaryWorkDir, "git", "worktree", "list", "--porcelain")
	if err != nil {
		return nil, fmt.Errorf("git worktree list failed: %w", err)
	}

	worktrees := ParseWorktreePorcelain(stdout)

	// Mark the primary worktree (first entry is always primary in porcelain output)
	if len(worktrees) > 0 {
		worktrees[0].IsPrimary = true
	}

	// Fetch dirty state for each worktree
	for i := range worktrees {
		dirtyCount, err := v.getDirtyFileCount(ctx, execFn, containerID, user, worktrees[i].Path)
		if err != nil {
			// Non-fatal: mark as unknown/clean
			continue
		}
		worktrees[i].DirtyFileCount = dirtyCount
		worktrees[i].IsDirty = dirtyCount > 0
	}

	return worktrees, nil
}

// getDirtyFileCount returns the number of dirty (uncommitted) files in a worktree.
func (v *WorktreeValidator) getDirtyFileCount(
	ctx context.Context,
	execFn execFunc,
	containerID, user, worktreePath string,
) (int, error) {
	stdout, _, err := execFn(ctx, containerID, user, worktreePath, "git", "status", "--porcelain=v1")
	if err != nil {
		return 0, err
	}

	count := 0
	for _, line := range strings.Split(stdout, "\n") {
		if strings.TrimSpace(line) != "" {
			count++
		}
	}
	return count, nil
}

// ParseWorktreePorcelain parses the output of `git worktree list --porcelain`.
// Format:
//
//	worktree /path/to/worktree
//	HEAD abc123def456
//	branch refs/heads/main
//	<blank line>
//	worktree /path/to/other
//	HEAD def456abc123
//	branch refs/heads/feature
//	<blank line>
//
// Detached HEAD entries have "detached" instead of "branch refs/heads/...".
func ParseWorktreePorcelain(output string) []WorktreeInfo {
	var worktrees []WorktreeInfo

	lines := strings.Split(output, "\n")
	var current *WorktreeInfo

	for _, line := range lines {
		line = strings.TrimRight(line, "\r")

		if strings.HasPrefix(line, "worktree ") {
			if current != nil {
				worktrees = append(worktrees, *current)
			}
			current = &WorktreeInfo{
				Path: strings.TrimPrefix(line, "worktree "),
			}
			continue
		}

		if current == nil {
			continue
		}

		if strings.HasPrefix(line, "HEAD ") {
			sha := strings.TrimPrefix(line, "HEAD ")
			// Abbreviate to 7 characters
			if len(sha) > 7 {
				sha = sha[:7]
			}
			current.HeadCommit = sha
			continue
		}

		if strings.HasPrefix(line, "branch ") {
			ref := strings.TrimPrefix(line, "branch ")
			// Strip refs/heads/ prefix
			current.Branch = strings.TrimPrefix(ref, "refs/heads/")
			continue
		}

		if line == "detached" {
			// Detached HEAD — branch stays empty (null in JSON)
			continue
		}

		// Blank line — end of current entry
		if strings.TrimSpace(line) == "" && current != nil {
			worktrees = append(worktrees, *current)
			current = nil
		}
	}

	// Handle last entry if no trailing newline
	if current != nil {
		worktrees = append(worktrees, *current)
	}

	return worktrees
}

// validateWorktreePathFormat validates the format of a worktree path.
// Path must be absolute, under /workspaces/, and contain no traversal.
func validateWorktreePathFormat(path string) error {
	if path == "" {
		return fmt.Errorf("worktree path is empty")
	}

	if !strings.HasPrefix(path, "/workspaces/") {
		return fmt.Errorf("worktree path must start with /workspaces/")
	}

	if strings.Contains(path, "..") {
		return fmt.Errorf("worktree path must not contain '..'")
	}

	if strings.ContainsRune(path, 0) {
		return fmt.Errorf("worktree path contains null byte")
	}

	// Must have at least one path component after /workspaces/
	rest := strings.TrimPrefix(path, "/workspaces/")
	rest = strings.TrimRight(rest, "/")
	if rest == "" {
		return fmt.Errorf("worktree path must specify a directory under /workspaces/")
	}

	return nil
}

// SanitizeWorktreeDirName generates a filesystem-safe directory name for a worktree.
// Format: <repoDirName>-wt-<sanitized-branch>
// Example: my-repo-wt-feature-auth
func SanitizeWorktreeDirName(repoDirName, branch string) string {
	// Sanitize branch: replace / with -, lowercase, remove unsafe chars
	sanitized := strings.ToLower(branch)
	sanitized = strings.ReplaceAll(sanitized, "/", "-")

	var b strings.Builder
	b.Grow(len(sanitized))
	for _, r := range sanitized {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '_' || r == '.':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}

	sanitized = b.String()

	// Collapse multiple dashes
	for strings.Contains(sanitized, "--") {
		sanitized = strings.ReplaceAll(sanitized, "--", "-")
	}

	// Trim leading/trailing dashes
	sanitized = strings.Trim(sanitized, "-")

	// Truncate to 50 characters
	if len(sanitized) > 50 {
		sanitized = sanitized[:50]
		sanitized = strings.TrimRight(sanitized, "-")
	}

	if sanitized == "" {
		sanitized = "worktree"
	}

	return repoDirName + "-wt-" + sanitized
}
