package server

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

func createWIPBundle(ctx context.Context, workDir string, entryThreshold int64) (string, string, []snapshotSkippedEntry, error) {
	return createWIPBundleWithGitState(ctx, workDir, entryThreshold, nil)
}

func createWIPBundleWithGitState(ctx context.Context, workDir string, entryThreshold int64, capturedState *snapshotGitState) (string, string, []snapshotSkippedEntry, error) {
	if ok, err := standaloneRepositoryPresent(workDir); err != nil || !ok {
		if err != nil {
			return "", "", nil, err
		}
		return "", "", nil, nil
	}
	if gitOperationInProgress(workDir) {
		return "", "", []snapshotSkippedEntry{{Path: workDir, Reason: "git operation in progress"}}, nil
	}
	gitState, err := captureStandaloneSnapshotGitState(ctx, workDir)
	if err != nil {
		return "", "", nil, fmt.Errorf("resolve base commit: %w", err)
	}
	if capturedState != nil {
		*capturedState = gitState
	}
	base := gitState.BaseCommit
	if _, err := runStandaloneGitCommand(ctx, workDir, nil, "status", "--porcelain"); err != nil {
		return base, "", nil, fmt.Errorf("git status: %w", err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return base, "", nil, fmt.Errorf("resolve HOME for snapshot WIP filtering: %w", err)
	}
	excludedPaths, err := snapshotWIPExcludedPaths(workDir, home, os.Getenv)
	if err != nil {
		return base, "", nil, fmt.Errorf("resolve snapshot WIP exclusions: %w", err)
	}

	indexFile, err := os.CreateTemp("", "sam-session-index-*")
	if err != nil {
		return base, "", nil, err
	}
	indexPath := indexFile.Name()
	_ = indexFile.Close()
	_ = os.Remove(indexPath)
	defer os.Remove(indexPath)
	gitEnv := []string{"GIT_INDEX_FILE=" + indexPath}
	if _, err := runStandaloneGitCommand(ctx, workDir, gitEnv, "read-tree", "HEAD"); err != nil {
		return base, "", nil, fmt.Errorf("initialize snapshot index: %w", err)
	}
	if _, err := runStandaloneGitCommand(ctx, workDir, gitEnv, "add", "-A"); err != nil {
		return base, "", nil, fmt.Errorf("stage snapshot index: %w", err)
	}
	if err := resetStandaloneSnapshotIndexPaths(ctx, workDir, gitEnv, excludedPaths); err != nil {
		return base, "", nil, fmt.Errorf("filter regenerated harness state from snapshot worktree: %w", err)
	}
	skipped := skipOversizedUntracked(workDir, entryThreshold, excludedPaths)
	for _, entry := range skipped {
		if entry.Path != "" {
			_, _ = runStandaloneGitCommand(ctx, workDir, gitEnv, "reset", "--", entry.Path)
		}
	}
	worktreeTree, err := runStandaloneGitCommand(ctx, workDir, gitEnv, "write-tree")
	if err != nil {
		return base, "", skipped, fmt.Errorf("write snapshot tree: %w", err)
	}
	indexTree, indexSkipped, err := writeFilteredIndexTree(ctx, workDir, entryThreshold, excludedPaths)
	skipped = append(skipped, indexSkipped...)
	if err != nil {
		return base, "", skipped, fmt.Errorf("write snapshot index tree: %w", err)
	}
	commitEnv := append(gitEnv, "GIT_AUTHOR_NAME=SAM Snapshot", "GIT_AUTHOR_EMAIL=snapshot@localhost", "GIT_COMMITTER_NAME=SAM Snapshot", "GIT_COMMITTER_EMAIL=snapshot@localhost")
	worktreeCommit, err := runStandaloneGitCommand(ctx, workDir, commitEnv, "commit-tree", worktreeTree, "-p", base, "-m", "SAM session worktree snapshot")
	if err != nil {
		return base, "", skipped, fmt.Errorf("create snapshot worktree commit: %w", err)
	}
	indexCommit, err := runStandaloneGitCommand(ctx, workDir, commitEnv, "commit-tree", indexTree, "-p", base, "-m", "SAM session index snapshot")
	if err != nil {
		return base, "", skipped, fmt.Errorf("create snapshot index commit: %w", err)
	}
	bundle, err := os.CreateTemp("", "sam-session-wip-*.bundle")
	if err != nil {
		return base, "", skipped, err
	}
	bundlePath := bundle.Name()
	_ = bundle.Close()
	snapshotRefPrefix := "refs/sam/session-snapshot/" + strings.TrimSuffix(filepath.Base(bundlePath), ".bundle")
	worktreeRef := snapshotRefPrefix + "/worktree"
	indexRef := snapshotRefPrefix + "/index"
	if _, err := runStandaloneGitCommand(ctx, workDir, nil, "update-ref", worktreeRef, worktreeCommit); err != nil {
		_ = os.Remove(bundlePath)
		return base, "", skipped, fmt.Errorf("create snapshot worktree ref: %w", err)
	}
	if _, err := runStandaloneGitCommand(ctx, workDir, nil, "update-ref", indexRef, indexCommit); err != nil {
		_, _ = runStandaloneGitCommand(context.Background(), workDir, nil, "update-ref", "-d", worktreeRef)
		_ = os.Remove(bundlePath)
		return base, "", skipped, fmt.Errorf("create snapshot index ref: %w", err)
	}
	defer func() {
		_, _ = runStandaloneGitCommand(context.Background(), workDir, nil, "update-ref", "-d", worktreeRef)
		_, _ = runStandaloneGitCommand(context.Background(), workDir, nil, "update-ref", "-d", indexRef)
	}()
	bundleArgs := append([]string{"bundle", "create", bundlePath, worktreeRef, indexRef}, snapshotWIPBundleBasis(ctx, standaloneSnapshotGit(workDir))...)
	if _, err := runStandaloneGitCommand(ctx, workDir, nil, bundleArgs...); err != nil {
		_ = os.Remove(bundlePath)
		return base, "", skipped, fmt.Errorf("create git bundle: %w", err)
	}
	return base, bundlePath, skipped, nil
}

func gitOperationInProgress(workDir string) bool {
	gitDir := filepath.Join(workDir, ".git")
	for _, marker := range []string{"MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"} {
		if _, err := os.Stat(filepath.Join(gitDir, marker)); err == nil {
			return true
		}
	}
	return false
}

func skipOversizedUntracked(workDir string, threshold int64, excludedPaths []string) []snapshotSkippedEntry {
	excluded := snapshotPathSet(excludedPaths)
	var skipped []snapshotSkippedEntry
	_ = filepath.WalkDir(workDir, func(path string, d os.DirEntry, err error) error {
		if err != nil || path == workDir {
			return nil
		}
		if d.IsDir() && d.Name() == ".git" {
			return filepath.SkipDir
		}
		if d.IsDir() {
			return nil
		}
		info, statErr := d.Info()
		if statErr != nil || info.Size() <= threshold {
			return nil
		}
		rel, _ := filepath.Rel(workDir, path)
		rel = filepath.ToSlash(filepath.Clean(rel))
		if excluded[rel] {
			return nil
		}
		if out, gitErr := runStandaloneGitCommand(context.Background(), workDir, nil, "check-ignore", "-q", rel); gitErr == nil && strings.TrimSpace(out) == "" {
			return nil
		}
		skipped = append(skipped, snapshotSkippedEntry{Path: rel, Reason: "entry exceeds size threshold", SizeBytes: info.Size()})
		return nil
	})
	return skipped
}

// writeFilteredIndexTree writes a git tree object from the repository index with
// oversized staged blobs removed. The worktree tree is filtered by
// skipOversizedUntracked, but the index tree is written from the real .git/index;
// without this a large staged blob (e.g. a 200MB file staged then deleted from
// the worktree) would bypass entryThreshold straight into the bundle. It never
// mutates the real index — it operates on a copy under GIT_INDEX_FILE. Skipped
// staged entries are returned so the manifest records the degradation; their
// staged-ness is lost on restore, mirroring the worktree oversized-skip.
func writeFilteredIndexTree(ctx context.Context, workDir string, threshold int64, excludedPaths []string) (string, []snapshotSkippedEntry, error) {
	skipped := skipOversizedStagedIndexEntries(ctx, workDir, threshold, excludedPaths)
	if len(skipped) == 0 && len(excludedPaths) == 0 {
		tree, err := runStandaloneGitCommand(ctx, workDir, nil, "write-tree")
		return tree, nil, err
	}
	copyPath, err := copyRepositoryIndex(ctx, workDir)
	if err != nil {
		return "", skipped, err
	}
	defer os.Remove(copyPath)
	env := []string{"GIT_INDEX_FILE=" + copyPath}
	for _, entry := range skipped {
		if entry.Path != "" {
			_, _ = runStandaloneGitCommand(ctx, workDir, env, "reset", "--", entry.Path)
		}
	}
	if err := resetStandaloneSnapshotIndexPaths(ctx, workDir, env, excludedPaths); err != nil {
		return "", skipped, err
	}
	tree, err := runStandaloneGitCommand(ctx, workDir, env, "write-tree")
	return tree, skipped, err
}

// skipOversizedStagedIndexEntries scans the repository index for staged blobs
// exceeding threshold. It reads blob sizes from the object database
// (git cat-file -s) rather than the worktree, so it catches staged content even
// when the worktree copy is absent or a different size.
func skipOversizedStagedIndexEntries(ctx context.Context, workDir string, threshold int64, excludedPaths []string) []snapshotSkippedEntry {
	out, err := runStandaloneGitCommand(ctx, workDir, nil, "ls-files", "-s", "-z")
	if err != nil || out == "" {
		return nil
	}
	// CombinedOutput's TrimSpace leaves the NUL record separators intact.
	entries := parseSnapshotIndexEntries(out, snapshotPathSet(excludedPaths))
	skipped, err := oversizedSnapshotIndexEntries(ctx, standaloneSnapshotGitWithInput(workDir), entries, threshold, "staged entry exceeds size threshold")
	if err != nil {
		slog.Warn("Snapshot staged-entry size check failed; capturing the index unfiltered", "workDir", workDir, "error", err)
		return nil
	}
	return skipped
}

func snapshotWIPExcludedPaths(workDir, home string, getenv func(string) string) ([]string, error) {
	workDir = filepath.Clean(workDir)
	if !filepath.IsAbs(workDir) || workDir == string(filepath.Separator) {
		return nil, fmt.Errorf("unsafe snapshot WIP worktree %q", workDir)
	}
	candidates, err := externalSnapshotRootCandidates(filepath.Clean(home), getenv)
	if err != nil {
		return nil, err
	}
	excluded := make(map[string]bool)
	for _, candidate := range candidates {
		if candidate.path == "" || !pathWithinRoot(workDir, candidate.path) {
			continue
		}
		rootRelative, relErr := filepath.Rel(workDir, candidate.path)
		if relErr != nil {
			return nil, relErr
		}
		for sensitivePath := range snapshotRootExcludeFiles[candidate.logicalName] {
			relativePath := filepath.ToSlash(filepath.Clean(filepath.Join(rootRelative, filepath.FromSlash(sensitivePath))))
			if relativePath == "." || relativePath == ".." || strings.HasPrefix(relativePath, "../") {
				return nil, fmt.Errorf("unsafe snapshot WIP exclusion %q", relativePath)
			}
			excluded[relativePath] = true
		}
	}
	paths := mapKeys(excluded)
	return paths, nil
}

func resetStandaloneSnapshotIndexPaths(ctx context.Context, workDir string, env, paths []string) error {
	for _, path := range paths {
		if _, err := runStandaloneGitCommand(ctx, workDir, env, "reset", "--", path); err != nil {
			return fmt.Errorf("reset %q in temporary snapshot index: %w", path, err)
		}
	}
	return nil
}

func snapshotPathSet(paths []string) map[string]bool {
	set := make(map[string]bool, len(paths))
	for _, path := range paths {
		set[filepath.ToSlash(filepath.Clean(path))] = true
	}
	return set
}

// copyRepositoryIndex copies the repository's index file to a temp path so a
// filtered index tree can be written via GIT_INDEX_FILE without mutating the
// real index. The caller must remove the returned path.
func copyRepositoryIndex(ctx context.Context, workDir string) (string, error) {
	indexPath, err := runStandaloneGitCommand(ctx, workDir, nil, "rev-parse", "--git-path", "index")
	if err != nil {
		return "", fmt.Errorf("resolve index path: %w", err)
	}
	indexPath = strings.TrimSpace(indexPath)
	if !filepath.IsAbs(indexPath) {
		indexPath = filepath.Join(workDir, indexPath)
	}
	data, err := os.ReadFile(indexPath)
	if err != nil {
		return "", fmt.Errorf("read index: %w", err)
	}
	tmp, err := os.CreateTemp("", "sam-session-index-copy-*")
	if err != nil {
		return "", err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return "", err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return "", err
	}
	return tmp.Name(), nil
}
