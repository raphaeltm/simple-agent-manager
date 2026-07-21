package server

import (
	"archive/tar"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func createWIPBundle(ctx context.Context, workDir string, entryThreshold int64) (string, string, []snapshotSkippedEntry, error) {
	if ok, err := standaloneRepositoryPresent(workDir); err != nil || !ok {
		if err != nil {
			return "", "", nil, err
		}
		return "", "", nil, nil
	}
	if gitOperationInProgress(workDir) {
		return "", "", []snapshotSkippedEntry{{Path: workDir, Reason: "git operation in progress"}}, nil
	}
	base, err := runStandaloneGitCommand(ctx, workDir, nil, "rev-parse", "HEAD")
	if err != nil {
		return "", "", nil, fmt.Errorf("resolve base commit: %w", err)
	}
	status, err := runStandaloneGitCommand(ctx, workDir, nil, "status", "--porcelain")
	if err != nil {
		return base, "", nil, fmt.Errorf("git status: %w", err)
	}
	if strings.TrimSpace(status) == "" {
		return base, "", nil, nil
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
	skipped := skipOversizedUntracked(workDir, entryThreshold)
	for _, entry := range skipped {
		if entry.Path != "" {
			_, _ = runStandaloneGitCommand(ctx, workDir, gitEnv, "reset", "--", entry.Path)
		}
	}
	worktreeTree, err := runStandaloneGitCommand(ctx, workDir, gitEnv, "write-tree")
	if err != nil {
		return base, "", skipped, fmt.Errorf("write snapshot tree: %w", err)
	}
	indexTree, err := runStandaloneGitCommand(ctx, workDir, nil, "write-tree")
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
	if _, err := runStandaloneGitCommand(ctx, workDir, nil, "bundle", "create", bundlePath, worktreeRef, indexRef); err != nil {
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

func skipOversizedUntracked(workDir string, threshold int64) []snapshotSkippedEntry {
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
		if out, gitErr := runStandaloneGitCommand(context.Background(), workDir, nil, "check-ignore", "-q", rel); gitErr == nil && strings.TrimSpace(out) == "" {
			return nil
		}
		skipped = append(skipped, snapshotSkippedEntry{Path: rel, Reason: "entry exceeds size threshold", SizeBytes: info.Size()})
		return nil
	})
	return skipped
}

func createHomeTar(homeDirFn func() (string, error), entryThreshold, totalBudget int64) (string, []snapshotSkippedEntry, error) {
	home, err := homeDirFn()
	if err != nil {
		return "", nil, err
	}
	home = filepath.Clean(home)
	out, err := os.CreateTemp("", "sam-session-home-*.tar")
	if err != nil {
		return "", nil, err
	}
	path := out.Name()
	tw := tar.NewWriter(out)
	var written int64
	var skipped []snapshotSkippedEntry
	walkErr := filepath.WalkDir(home, func(path string, d os.DirEntry, err error) error {
		if err != nil || path == home {
			return nil
		}
		rel, _ := filepath.Rel(home, path)
		if shouldExcludeHomePath(rel) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, statErr := d.Info()
		if statErr != nil {
			return nil
		}
		if info.Size() > entryThreshold {
			skipped = append(skipped, snapshotSkippedEntry{Path: "~/" + rel, Reason: "entry exceeds size threshold", SizeBytes: info.Size()})
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !info.Mode().IsRegular() && !info.IsDir() {
			skipped = append(skipped, snapshotSkippedEntry{Path: "~/" + rel, Reason: "unsupported home entry type"})
			return nil
		}
		if !info.IsDir() && written+info.Size() > totalBudget {
			skipped = append(skipped, snapshotSkippedEntry{Path: "~/" + rel, Reason: "snapshot budget exhausted", SizeBytes: info.Size()})
			return nil
		}
		header, headerErr := tar.FileInfoHeader(info, "")
		if headerErr != nil {
			return nil
		}
		header.Name = rel
		if err := tw.WriteHeader(header); err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			f, openErr := os.Open(path)
			if openErr != nil {
				return nil
			}
			n, copyErr := io.Copy(tw, f)
			_ = f.Close()
			written += n
			if copyErr != nil {
				return copyErr
			}
		}
		return nil
	})
	closeErr := tw.Close()
	fileCloseErr := out.Close()
	if walkErr != nil || closeErr != nil || fileCloseErr != nil {
		_ = os.Remove(path)
		if walkErr != nil {
			return "", skipped, walkErr
		}
		if closeErr != nil {
			return "", skipped, closeErr
		}
		return "", skipped, fileCloseErr
	}
	return path, skipped, nil
}

func shouldExcludeHomePath(rel string) bool {
	first := strings.Split(filepath.ToSlash(rel), "/")[0]
	switch first {
	case ".cache", ".npm", ".cargo", ".rustup", ".local", "node_modules", ".docker":
		return true
	default:
		return false
	}
}

func rejectSymlinkPath(root, target string) error {
	rel, err := filepath.Rel(root, target)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("snapshot target is outside home")
	}
	current := root
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		info, statErr := os.Lstat(current)
		if os.IsNotExist(statErr) {
			continue
		}
		if statErr != nil {
			return statErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("snapshot target traverses symlink: %s", rel)
		}
	}
	return nil
}
