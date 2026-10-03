package server

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (s *Server) containerGit(ctx context.Context, target *containerSnapshotTarget, extraEnv []string, args ...string) (string, error) {
	output, err := s.runSnapshotWorkspaceCommand(ctx, target, extraEnv, append([]string{"git"}, args...)...)
	return strings.TrimSpace(string(output)), err
}

func (s *Server) containerGitOperationInProgress(ctx context.Context, target *containerSnapshotTarget) bool {
	for _, marker := range []string{"MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"} {
		path, err := s.containerGit(ctx, target, nil, "rev-parse", "--git-path", marker)
		if err != nil || path == "" {
			continue
		}
		if _, err := s.runSnapshotWorkspaceCommand(ctx, target, nil, "stat", "--", path); err == nil {
			return true
		}
	}
	return false
}

func (s *Server) skipOversizedContainerUntracked(ctx context.Context, target *containerSnapshotTarget, syntheticIndex string, threshold int64, excludedPaths []string) []snapshotSkippedEntry {
	output, err := s.runSnapshotWorkspaceCommand(ctx, target, nil, "git", "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil || len(output) == 0 {
		return nil
	}
	excluded := snapshotPathSet(excludedPaths)
	untracked := make(map[string]bool)
	for _, raw := range bytes.Split(output, []byte{0}) {
		if path := filepath.ToSlash(filepath.Clean(string(raw))); len(raw) > 0 && !excluded[path] {
			untracked[path] = true
		}
	}
	if len(untracked) == 0 {
		return nil
	}
	// `git add -A` already hashed the untracked files into the synthetic index,
	// so their sizes come from one batched lookup instead of a `stat` per file.
	syntheticEnv := []string{"GIT_INDEX_FILE=" + syntheticIndex}
	staged, err := s.runSnapshotWorkspaceCommand(ctx, target, syntheticEnv, "git", "ls-files", "-s", "-z")
	if err != nil {
		return nil
	}
	var entries []snapshotIndexEntry
	for _, entry := range parseSnapshotIndexEntries(string(staged), nil) {
		if untracked[entry.path] {
			entries = append(entries, entry)
		}
	}
	skipped, err := oversizedSnapshotIndexEntries(ctx, s.containerSnapshotGitWithInput(target), entries, threshold, "entry exceeds size threshold")
	if err != nil {
		slog.Warn("Container snapshot untracked-entry size check failed; capturing untracked files unfiltered", "workspace", target.workDir, "error", err)
		return nil
	}
	for _, entry := range skipped {
		_, _ = s.containerGit(ctx, target, syntheticEnv, "reset", "--", entry.Path)
	}
	return skipped
}

func (s *Server) oversizedContainerIndexEntries(ctx context.Context, target *containerSnapshotTarget, threshold int64, excludedPaths []string) []snapshotSkippedEntry {
	output, err := s.runSnapshotWorkspaceCommand(ctx, target, nil, "git", "ls-files", "-s", "-z")
	if err != nil || len(output) == 0 {
		return nil
	}
	entries := parseSnapshotIndexEntries(string(output), snapshotPathSet(excludedPaths))
	skipped, err := oversizedSnapshotIndexEntries(ctx, s.containerSnapshotGitWithInput(target), entries, threshold, "staged entry exceeds size threshold")
	if err != nil {
		slog.Warn("Container snapshot staged-entry size check failed; capturing the index unfiltered", "workspace", target.workDir, "error", err)
		return nil
	}
	return skipped
}

func (s *Server) resolveContainerSnapshotWIPExcludedPaths(ctx context.Context, target *containerSnapshotTarget) ([]string, error) {
	homeOutput, err := s.runSnapshotWorkspaceCommand(ctx, target, nil, "printenv", "HOME")
	if err != nil {
		return nil, fmt.Errorf("resolve container HOME for snapshot WIP filtering: %w", err)
	}
	home := filepath.Clean(strings.TrimSpace(string(homeOutput)))
	envValues := make(map[string]string)
	for _, key := range []string{"CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_DATA_HOME"} {
		output, envErr := s.runSnapshotWorkspaceCommand(ctx, target, nil, "printenv", key)
		if envErr == nil {
			envValues[key] = strings.TrimSpace(string(output))
		}
	}
	return snapshotWIPExcludedPaths(target.workDir, home, func(key string) string { return envValues[key] })
}

func (s *Server) resetContainerSnapshotIndexPaths(ctx context.Context, target *containerSnapshotTarget, env, paths []string) error {
	for _, path := range paths {
		if _, err := s.containerGit(ctx, target, env, "reset", "--", path); err != nil {
			return fmt.Errorf("reset %q in temporary container snapshot index: %w", path, err)
		}
	}
	return nil
}

func (s *Server) createContainerWIPBundle(ctx context.Context, target *containerSnapshotTarget, entryThreshold, maxBytes int64, reportProgress func(context.Context, string)) (string, string, []snapshotSkippedEntry, error) {
	return s.createContainerWIPBundleWithGitState(ctx, target, entryThreshold, maxBytes, reportProgress, nil)
}

func (s *Server) createContainerWIPBundleWithGitState(ctx context.Context, target *containerSnapshotTarget, entryThreshold, maxBytes int64, reportProgress func(context.Context, string), capturedState *snapshotGitState) (string, string, []snapshotSkippedEntry, error) {
	present, err := s.containerGit(ctx, target, nil, "rev-parse", "--is-inside-work-tree")
	if err != nil || present != "true" {
		return "", "", nil, nil
	}
	if s.containerGitOperationInProgress(ctx, target) {
		return "", "", []snapshotSkippedEntry{{Path: target.workDir, Reason: "git operation in progress"}}, nil
	}
	gitCommand := func(ctx context.Context, env []string, args ...string) (string, error) {
		return s.containerGit(ctx, target, env, args...)
	}
	gitState, err := captureSnapshotGitState(ctx, gitCommand)
	if err != nil {
		return "", "", nil, fmt.Errorf("resolve container snapshot base commit: %w", err)
	}
	if capturedState != nil {
		*capturedState = gitState
	}
	base := gitState.BaseCommit
	if _, err := s.containerGit(ctx, target, nil, "status", "--porcelain"); err != nil {
		return base, "", nil, fmt.Errorf("container git status: %w", err)
	}
	if reportProgress != nil {
		reportProgress(ctx, "wip-capture")
	}
	excludedPaths, err := s.resolveContainerSnapshotWIPExcludedPaths(ctx, target)
	if err != nil {
		return base, "", nil, err
	}

	suffix := randomEventID()
	worktreeIndex := "/tmp/sam-session-index-" + suffix
	filteredIndex := "/tmp/sam-session-index-filtered-" + suffix
	containerBundle := "/tmp/sam-session-wip-" + suffix + ".bundle"
	defer s.removeContainerSnapshotPath(target, worktreeIndex)
	defer s.removeContainerSnapshotPath(target, filteredIndex)
	defer s.removeContainerSnapshotPath(target, containerBundle)
	worktreeEnv := []string{"GIT_INDEX_FILE=" + worktreeIndex}
	if _, err := s.containerGit(ctx, target, worktreeEnv, "read-tree", "HEAD"); err != nil {
		return base, "", nil, fmt.Errorf("initialize container snapshot index: %w", err)
	}
	if _, err := s.containerGit(ctx, target, worktreeEnv, "add", "-A"); err != nil {
		return base, "", nil, fmt.Errorf("stage container snapshot index: %w", err)
	}
	if err := s.resetContainerSnapshotIndexPaths(ctx, target, worktreeEnv, excludedPaths); err != nil {
		return base, "", nil, fmt.Errorf("filter regenerated harness state from container snapshot worktree: %w", err)
	}
	skipped := s.skipOversizedContainerUntracked(ctx, target, worktreeIndex, entryThreshold, excludedPaths)
	worktreeTree, err := s.containerGit(ctx, target, worktreeEnv, "write-tree")
	if err != nil {
		return base, "", skipped, fmt.Errorf("write container snapshot tree: %w", err)
	}

	indexSkipped := s.oversizedContainerIndexEntries(ctx, target, entryThreshold, excludedPaths)
	skipped = append(skipped, indexSkipped...)
	indexTree := ""
	if len(indexSkipped) == 0 && len(excludedPaths) == 0 {
		indexTree, err = s.containerGit(ctx, target, nil, "write-tree")
	} else {
		indexPath, resolveErr := s.containerGit(ctx, target, nil, "rev-parse", "--git-path", "index")
		if resolveErr != nil {
			return base, "", skipped, fmt.Errorf("resolve container repository index: %w", resolveErr)
		}
		if _, copyErr := s.runSnapshotWorkspaceCommand(ctx, target, nil, "cp", "--", indexPath, filteredIndex); copyErr != nil {
			return base, "", skipped, fmt.Errorf("copy container repository index: %w", copyErr)
		}
		filteredEnv := []string{"GIT_INDEX_FILE=" + filteredIndex}
		for _, entry := range indexSkipped {
			_, _ = s.containerGit(ctx, target, filteredEnv, "reset", "--", entry.Path)
		}
		if resetErr := s.resetContainerSnapshotIndexPaths(ctx, target, filteredEnv, excludedPaths); resetErr != nil {
			return base, "", skipped, resetErr
		}
		indexTree, err = s.containerGit(ctx, target, filteredEnv, "write-tree")
	}
	if err != nil {
		return base, "", skipped, fmt.Errorf("write container snapshot index tree: %w", err)
	}

	commitEnv := append(worktreeEnv,
		"GIT_AUTHOR_NAME=SAM Snapshot", "GIT_AUTHOR_EMAIL=snapshot@localhost",
		"GIT_COMMITTER_NAME=SAM Snapshot", "GIT_COMMITTER_EMAIL=snapshot@localhost")
	worktreeCommit, err := s.containerGit(ctx, target, commitEnv, "commit-tree", worktreeTree, "-p", base, "-m", "SAM session worktree snapshot")
	if err != nil {
		return base, "", skipped, fmt.Errorf("create container snapshot worktree commit: %w", err)
	}
	indexCommit, err := s.containerGit(ctx, target, commitEnv, "commit-tree", indexTree, "-p", base, "-m", "SAM session index snapshot")
	if err != nil {
		return base, "", skipped, fmt.Errorf("create container snapshot index commit: %w", err)
	}
	refPrefix := "refs/sam/session-snapshot/" + suffix
	worktreeRef := refPrefix + "/worktree"
	indexRef := refPrefix + "/index"
	if _, err := s.containerGit(ctx, target, nil, "update-ref", worktreeRef, worktreeCommit); err != nil {
		return base, "", skipped, fmt.Errorf("create container worktree snapshot ref: %w", err)
	}
	defer func() { _, _ = s.containerGit(context.Background(), target, nil, "update-ref", "-d", worktreeRef) }()
	if _, err := s.containerGit(ctx, target, nil, "update-ref", indexRef, indexCommit); err != nil {
		return base, "", skipped, fmt.Errorf("create container index snapshot ref: %w", err)
	}
	defer func() { _, _ = s.containerGit(context.Background(), target, nil, "update-ref", "-d", indexRef) }()
	bundleArgs := append([]string{"bundle", "create", containerBundle, worktreeRef, indexRef}, snapshotWIPBundleBasis(ctx, gitCommand)...)
	if _, err := s.containerGit(ctx, target, nil, bundleArgs...); err != nil {
		return base, "", skipped, fmt.Errorf("create container git bundle: %w", err)
	}
	if reportProgress != nil {
		reportProgress(ctx, "wip-capture")
	}
	localPath, err := s.copyContainerSnapshotArtifact(ctx, target, containerBundle, "sam-session-wip-*.bundle", maxBytes)
	if err != nil {
		return base, "", skipped, err
	}
	return base, localPath, skipped, nil
}

func parseSnapshotBundleRefs(path string) (map[string]string, error) {
	heads, err := runStandaloneGitCommand(context.Background(), "", nil, "bundle", "list-heads", path)
	if err != nil {
		return nil, fmt.Errorf("list snapshot bundle heads: %w: %s", err, heads)
	}
	refs := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSpace(heads), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 {
			refs[fields[1]] = fields[0]
		}
	}
	if len(refs) == 0 {
		return nil, fmt.Errorf("snapshot bundle has no restorable ref")
	}
	return refs, nil
}

func (s *Server) downloadAndRestoreContainerWIP(ctx context.Context, target *containerSnapshotTarget, downloadPath, token string, idleTimeout time.Duration, maxBytes int64, baseCommit string) error {
	return s.downloadAndRestoreContainerWIPWithGitState(ctx, target, downloadPath, token, idleTimeout, maxBytes, snapshotGitState{BaseCommit: baseCommit})
}

func (s *Server) downloadAndRestoreContainerWIPWithGitState(ctx context.Context, target *containerSnapshotTarget, downloadPath, token string, idleTimeout time.Duration, maxBytes int64, gitState snapshotGitState) error {
	hostPath, err := s.downloadSnapshotArtifactToTemp(ctx, downloadPath, token, idleTimeout, "sam-session-restore-wip-*.bundle", maxBytes)
	if err != nil {
		return err
	}
	defer os.Remove(hostPath)
	refs, err := parseSnapshotBundleRefs(hostPath)
	if err != nil {
		return err
	}
	containerPath := "/tmp/sam-session-restore-wip-" + randomEventID() + ".bundle"
	defer s.removeContainerSnapshotPath(target, containerPath)
	if err := s.writeHostSnapshotArtifactToContainer(ctx, target, hostPath, containerPath); err != nil {
		return err
	}
	gitCommand := func(ctx context.Context, env []string, args ...string) (string, error) {
		return s.containerGit(ctx, target, env, args...)
	}
	if err := ensureSnapshotBundlePrerequisites(ctx, gitCommand, hostPath, gitState); err != nil {
		return err
	}
	worktreeRef, worktreeCommit := snapshotBundleRef(refs, "/worktree")
	indexRef, indexCommit := snapshotBundleRef(refs, "/index")
	if worktreeRef != "" && indexRef != "" {
		if output, err := s.containerGit(ctx, target, nil, "fetch", containerPath, worktreeRef, indexRef); err != nil {
			return fmt.Errorf("fetch container snapshot bundle: %w: %s", err, output)
		}
		if err := restoreSnapshotGitState(ctx, gitCommand, gitState); err != nil {
			return err
		}
		if output, err := s.containerGit(ctx, target, nil, "read-tree", "--reset", "-u", worktreeCommit); err != nil {
			return fmt.Errorf("materialize container snapshot worktree: %w: %s", err, output)
		}
		if strings.TrimSpace(gitState.BaseCommit) != "" {
			if output, err := s.containerGit(ctx, target, nil, "reset", "--soft", gitState.BaseCommit); err != nil {
				return fmt.Errorf("restore container snapshot base commit: %w: %s", err, output)
			}
		}
		if output, err := s.containerGit(ctx, target, nil, "read-tree", indexCommit); err != nil {
			return fmt.Errorf("restore container snapshot index: %w: %s", err, output)
		}
		return nil
	}
	var legacyRef string
	for ref := range refs {
		legacyRef = ref
		break
	}
	if output, err := s.containerGit(ctx, target, nil, "fetch", containerPath, legacyRef); err != nil {
		return fmt.Errorf("fetch legacy container snapshot bundle: %w: %s", err, output)
	}
	if err := restoreSnapshotGitState(ctx, gitCommand, gitState); err != nil {
		return err
	}
	if output, err := s.containerGit(ctx, target, nil, "read-tree", "--reset", "-u", "FETCH_HEAD"); err != nil {
		return fmt.Errorf("materialize legacy container snapshot tree: %w: %s", err, output)
	}
	if strings.TrimSpace(gitState.BaseCommit) != "" {
		if output, err := s.containerGit(ctx, target, nil, "reset", "--mixed", gitState.BaseCommit); err != nil {
			return fmt.Errorf("restore legacy container snapshot base: %w: %s", err, output)
		}
	}
	return nil
}
