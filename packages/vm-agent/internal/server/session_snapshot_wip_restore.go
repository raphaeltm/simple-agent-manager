package server

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

func (s *Server) downloadAndRestoreWIP(ctx context.Context, downloadPath, token string, idleTimeout time.Duration, workDir, baseCommit string) error {
	return s.downloadAndRestoreWIPWithGitState(ctx, downloadPath, token, idleTimeout, workDir, snapshotGitState{BaseCommit: baseCommit})
}

func (s *Server) downloadAndRestoreWIPWithGitState(ctx context.Context, downloadPath, token string, idleTimeout time.Duration, workDir string, gitState snapshotGitState) error {
	res, err := s.snapshotDownload(ctx, downloadPath, token)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	tmp, err := os.CreateTemp("", "sam-session-restore-*.bundle")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	_, copyErr := io.Copy(tmp, newIdleReader(res.Body, idleTimeout))
	closeErr := tmp.Close()
	if copyErr != nil {
		_ = os.Remove(tmpPath)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(tmpPath)
		return closeErr
	}
	defer os.Remove(tmpPath)
	heads, err := runStandaloneGitCommand(ctx, workDir, nil, "bundle", "list-heads", tmpPath)
	if err != nil {
		return fmt.Errorf("list snapshot bundle heads: %w: %s", err, heads)
	}
	bundleRefs := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSpace(heads), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 {
			bundleRefs[fields[1]] = fields[0]
		}
	}
	if len(bundleRefs) == 0 {
		return fmt.Errorf("snapshot bundle has no restorable ref")
	}
	worktreeRef, worktreeCommit := snapshotBundleRef(bundleRefs, "/worktree")
	indexRef, indexCommit := snapshotBundleRef(bundleRefs, "/index")
	if worktreeRef != "" && indexRef != "" {
		if output, err := runStandaloneGitCommand(ctx, workDir, nil, "fetch", tmpPath, worktreeRef, indexRef); err != nil {
			return fmt.Errorf("fetch snapshot bundle: %w: %s", err, output)
		}
		if err := restoreStandaloneSnapshotGitState(ctx, workDir, gitState); err != nil {
			return err
		}
		if output, err := runStandaloneGitCommand(ctx, workDir, nil, "read-tree", "--reset", "-u", worktreeCommit); err != nil {
			return fmt.Errorf("materialize snapshot worktree: %w: %s", err, output)
		}
		if strings.TrimSpace(gitState.BaseCommit) != "" {
			if output, err := runStandaloneGitCommand(ctx, workDir, nil, "reset", "--soft", gitState.BaseCommit); err != nil {
				return fmt.Errorf("restore snapshot base commit: %w: %s", err, output)
			}
		}
		if output, err := runStandaloneGitCommand(ctx, workDir, nil, "read-tree", indexCommit); err != nil {
			return fmt.Errorf("restore snapshot index: %w: %s", err, output)
		}
		return nil
	}

	// Version 1 bundles written before index preservation contained a single
	// synthetic commit. Keep restoring them for compatibility; their original
	// staged/unstaged split was not encoded and therefore cannot be recovered.
	var legacyRef string
	for ref := range bundleRefs {
		legacyRef = ref
		break
	}
	if output, err := runStandaloneGitCommand(ctx, workDir, nil, "fetch", tmpPath, legacyRef); err != nil {
		return fmt.Errorf("fetch snapshot bundle: %w: %s", err, output)
	}
	if err := restoreStandaloneSnapshotGitState(ctx, workDir, gitState); err != nil {
		return err
	}
	if output, err := runStandaloneGitCommand(ctx, workDir, nil, "read-tree", "--reset", "-u", "FETCH_HEAD"); err != nil {
		return fmt.Errorf("materialize snapshot tree: %w: %s", err, output)
	}
	if strings.TrimSpace(gitState.BaseCommit) != "" {
		if output, err := runStandaloneGitCommand(ctx, workDir, nil, "reset", "--mixed", gitState.BaseCommit); err != nil {
			return fmt.Errorf("restore snapshot base commit: %w: %s", err, output)
		}
	}
	return nil
}

func snapshotBundleRef(refs map[string]string, suffix string) (string, string) {
	for ref, commit := range refs {
		if strings.HasSuffix(ref, suffix) {
			return ref, commit
		}
	}
	return "", ""
}
