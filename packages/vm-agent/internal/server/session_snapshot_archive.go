package server

import (
	"archive/tar"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const snapshotExternalRootsPrefix = ".sam-snapshot-roots"

const (
	snapshotRootCodex    = "codex"
	snapshotRootClaude   = "claude"
	snapshotRootOpenCode = "opencode"
)

type snapshotArchiveRoot struct {
	logicalName string
	path        string
}

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
	excluded := snapshotPathSet(excludedPaths)
	out, err := runStandaloneGitCommand(ctx, workDir, nil, "ls-files", "-s", "-z")
	if err != nil || out == "" {
		return nil
	}
	var skipped []snapshotSkippedEntry
	// `git ls-files -s -z` records are NUL-separated; each is
	// "<mode> <object> <stage>\t<path>". CombinedOutput's TrimSpace leaves NUL
	// bytes intact (NUL is not unicode whitespace), so the record structure is
	// preserved.
	for _, record := range strings.Split(out, "\x00") {
		if record == "" {
			continue
		}
		meta, path, found := strings.Cut(record, "\t")
		if !found || path == "" {
			continue
		}
		path = filepath.ToSlash(filepath.Clean(path))
		if excluded[path] {
			continue
		}
		fields := strings.Fields(meta)
		if len(fields) < 2 {
			continue
		}
		sizeOut, sizeErr := runStandaloneGitCommand(ctx, workDir, nil, "cat-file", "-s", fields[1])
		if sizeErr != nil {
			continue
		}
		size, convErr := strconv.ParseInt(strings.TrimSpace(sizeOut), 10, 64)
		if convErr != nil || size <= threshold {
			continue
		}
		skipped = append(skipped, snapshotSkippedEntry{Path: path, Reason: "staged entry exceeds size threshold", SizeBytes: size})
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

func createHomeTar(homeDirFn func() (string, error), entryThreshold, totalBudget int64) (string, []snapshotSkippedEntry, error) {
	return createSessionStateTarWithContext(context.Background(), homeDirFn, entryThreshold, totalBudget, false, nil)
}

// createSessionStateTar archives HOME plus any harness state root configured
// outside HOME. External source paths are never serialized: they are mapped to
// a fixed logical namespace and resolved again from the fresh runtime on restore.
func createSessionStateTar(homeDirFn func() (string, error), entryThreshold, totalBudget int64, includeExternalRoots bool) (string, []snapshotSkippedEntry, error) {
	return createSessionStateTarWithContext(context.Background(), homeDirFn, entryThreshold, totalBudget, includeExternalRoots, nil)
}

func createSessionStateTarWithContext(
	ctx context.Context,
	homeDirFn func() (string, error),
	entryThreshold, totalBudget int64,
	includeExternalRoots bool,
	reportProgress func(context.Context, string),
) (string, []snapshotSkippedEntry, error) {
	home, err := homeDirFn()
	if err != nil {
		return "", nil, err
	}
	home = filepath.Clean(home)
	roots := []snapshotArchiveRoot{{path: home}}
	if includeExternalRoots {
		externalRoots, rootsErr := resolveLocalExternalSnapshotRoots(home)
		if rootsErr != nil {
			return "", nil, rootsErr
		}
		roots = append(roots, externalRoots...)
	}
	out, err := os.CreateTemp("", "sam-session-home-*.tar")
	if err != nil {
		return "", nil, err
	}
	path := out.Name()
	tw := tar.NewWriter(out)
	var written int64
	var entryCount int
	var skipped []snapshotSkippedEntry
	var walkErr error
	for _, root := range roots {
		if walkErr != nil {
			break
		}
		if err := ctx.Err(); err != nil {
			walkErr = err
			break
		}
		info, statErr := os.Lstat(root.path)
		if os.IsNotExist(statErr) {
			continue
		}
		if statErr != nil {
			walkErr = statErr
			break
		}
		if !info.IsDir() {
			walkErr = fmt.Errorf("snapshot state root %q is not a directory", root.logicalName)
			break
		}
		walkErr = filepath.WalkDir(root.path, func(path string, d os.DirEntry, walkPathErr error) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if reportProgress != nil {
				reportProgress(ctx, "home-walk")
			}
			if walkPathErr != nil || path == root.path {
				return walkPathErr
			}
			rel, relErr := filepath.Rel(root.path, path)
			if relErr != nil {
				return relErr
			}
			if shouldExcludeSnapshotRootPath(root.logicalName, rel) {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			entryInfo, entryErr := d.Info()
			if entryErr != nil {
				return entryErr
			}
			displayPath := snapshotDisplayPath(root.logicalName, rel)
			if entryInfo.Size() > entryThreshold {
				skipped = append(skipped, snapshotSkippedEntry{Path: displayPath, Reason: "entry exceeds size threshold", SizeBytes: entryInfo.Size()})
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if !entryInfo.Mode().IsRegular() && !entryInfo.IsDir() {
				skipped = append(skipped, snapshotSkippedEntry{Path: displayPath, Reason: "unsupported home entry type"})
				return nil
			}
			if !entryInfo.IsDir() && written+entryInfo.Size() > totalBudget {
				skipped = append(skipped, snapshotSkippedEntry{Path: displayPath, Reason: "snapshot budget exhausted", SizeBytes: entryInfo.Size()})
				return nil
			}
			entryCount++
			if entryCount > defaultSnapshotMaxArchiveEntries {
				return fmt.Errorf("snapshot HOME archive exceeds entry limit")
			}
			header, headerErr := tar.FileInfoHeader(entryInfo, "")
			if headerErr != nil {
				return headerErr
			}
			header.Name = snapshotArchiveName(root.logicalName, rel)
			if err := tw.WriteHeader(header); err != nil {
				return err
			}
			if entryInfo.Mode().IsRegular() {
				f, openErr := os.Open(path)
				if openErr != nil {
					return openErr
				}
				n, copyErr := copySnapshotFileWithContext(ctx, tw, f, func() {
					if reportProgress != nil {
						reportProgress(ctx, "home-copy")
					}
				})
				closeErr := f.Close()
				written += n
				if copyErr != nil {
					return copyErr
				}
				if closeErr != nil {
					return closeErr
				}
			}
			return nil
		})
	}
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
	if _, err := validateSnapshotHomeTar(path, entryThreshold, totalBudget); err != nil {
		_ = os.Remove(path)
		return "", skipped, fmt.Errorf("validate generated HOME archive: %w", err)
	}
	return path, skipped, nil
}

func copySnapshotFileWithContext(ctx context.Context, dst io.Writer, src io.Reader, reportProgress func()) (int64, error) {
	buf := make([]byte, 1024*1024)
	var written int64
	for {
		if err := ctx.Err(); err != nil {
			return written, err
		}
		nr, readErr := src.Read(buf)
		if nr > 0 {
			nw, writeErr := dst.Write(buf[:nr])
			written += int64(nw)
			if reportProgress != nil {
				reportProgress()
			}
			if writeErr != nil {
				return written, writeErr
			}
			if nw != nr {
				return written, io.ErrShortWrite
			}
		}
		if readErr == io.EOF {
			return written, nil
		}
		if readErr != nil {
			return written, readErr
		}
	}
}

func resolveLocalExternalSnapshotRoots(home string) ([]snapshotArchiveRoot, error) {
	candidates, err := externalSnapshotRootCandidates(home, os.Getenv)
	if err != nil {
		return nil, err
	}
	var roots []snapshotArchiveRoot
	for _, candidate := range candidates {
		if candidate.path == "" {
			continue
		}
		candidate.path = filepath.Clean(candidate.path)
		if !filepath.IsAbs(candidate.path) || pathWithinRoot(home, candidate.path) {
			continue
		}
		roots = append(roots, candidate)
	}
	return roots, nil
}

func externalSnapshotRootCandidates(home string, getenv func(string) string) ([]snapshotArchiveRoot, error) {
	dataHome := strings.TrimSpace(getenv("XDG_DATA_HOME"))
	if dataHome == "" {
		dataHome = filepath.Join(home, ".local", "share")
	}
	candidates := []snapshotArchiveRoot{
		{logicalName: snapshotRootCodex, path: strings.TrimSpace(getenv("CODEX_HOME"))},
		{logicalName: snapshotRootClaude, path: strings.TrimSpace(getenv("CLAUDE_CONFIG_DIR"))},
		{logicalName: snapshotRootOpenCode, path: filepath.Join(dataHome, "opencode")},
	}
	for index := range candidates {
		candidate := &candidates[index]
		if candidate.path == "" {
			continue
		}
		candidate.path = filepath.Clean(candidate.path)
		if !filepath.IsAbs(candidate.path) || candidate.path == string(filepath.Separator) {
			return nil, fmt.Errorf("unsafe %s snapshot state root %q", candidate.logicalName, candidate.path)
		}
	}
	return candidates, nil
}

func pathWithinRoot(root, candidate string) bool {
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(candidate))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func snapshotArchiveName(logicalName, rel string) string {
	rel = filepath.ToSlash(filepath.Clean(rel))
	if logicalName == "" {
		return rel
	}
	return snapshotExternalRootsPrefix + "/" + logicalName + "/" + rel
}

func snapshotDisplayPath(logicalName, rel string) string {
	if logicalName == "" {
		return "~/" + filepath.ToSlash(rel)
	}
	return "$" + strings.ToUpper(logicalName) + "_STATE/" + filepath.ToSlash(rel)
}

func shouldExcludeSnapshotRootPath(logicalName, rel string) bool {
	clean := filepath.ToSlash(filepath.Clean(rel))
	if logicalName == "" {
		return shouldExcludeHomePath(clean)
	}
	for _, prefix := range snapshotRootExcludePrefixes[logicalName] {
		if clean == prefix || strings.HasPrefix(clean, prefix+"/") {
			return true
		}
	}
	return snapshotRootExcludeFiles[logicalName][clean]
}

var snapshotRootExcludePrefixes = map[string][]string{
	snapshotRootCodex:    {"tmp"},
	snapshotRootClaude:   {"debug"},
	snapshotRootOpenCode: {"cache"},
}

var snapshotRootExcludeFiles = map[string]map[string]bool{
	snapshotRootCodex: {
		"auth.json":   true,
		"config.toml": true,
	},
	snapshotRootClaude: {
		".credentials.json": true,
		"credentials.json":  true,
	},
	snapshotRootOpenCode: {
		"auth.json":        true,
		"credentials.json": true,
		"providers.json":   true,
	},
}

// homeExcludePrefixes are HOME-relative path prefixes whose entire subtree is
// excluded from the snapshot tar. Two kinds live here: bulky re-provisioned
// caches (safe to drop) and credential-bearing paths that MUST never reach R2
// (the HOME tar is uploaded to 7-day R2 storage). Restore re-provisions all
// credentials fresh from the control plane, so excluding them is lossless.
// Matched on whole path segments: ".ssh" excludes ".ssh" and ".ssh/id_ed25519"
// but not ".sshfoo" or ".config/gh-other".
var homeExcludePrefixes = []string{
	// Caches — bulky, re-fetchable.
	".cache", ".npm", ".cargo", ".rustup", ".local/bin", ".local/lib", "node_modules", ".docker",
	".codex/tmp", ".claude/debug", ".oh-my-zsh", ".vscode-server",
	"go/pkg", ".local/share/pnpm", ".nvm", ".bun/install/cache", ".gradle", ".m2",
	// Credential-bearing paths — plaintext secrets must never be uploaded.
	".ssh", ".aws", ".netrc", ".npmrc", ".config/gh", ".kube", ".azure", ".config/gcloud",
	// Reserved snapshot namespace. HOME content must never be able to masquerade
	// as a control-plane-selected external harness root.
	snapshotExternalRootsPrefix,
}

// homeExcludeFiles are exact HOME-relative files excluded from the tar. Their
// parent directories (.claude, .codex) ALSO hold harness transcript/session
// state that LoadSession-resume depends on, so only the credential file itself
// is dropped — never the whole directory.
var homeExcludeFiles = map[string]bool{
	".claude/.credentials.json": true,
	".codex/auth.json":          true,
	// Generated runtime configuration can contain callback-token URLs (Codex)
	// or literal MCP bearer tokens (Vibe). It is regenerated from fresh control-
	// plane credentials before the restored harness is loaded.
	".codex/config.toml": true,
	".vibe/config.toml":  true,
	".git-credentials":   true,
	".pypirc":            true,
}

func shouldExcludeHomePath(rel string) bool {
	clean := filepath.ToSlash(rel)
	if homeExcludeFiles[clean] {
		return true
	}
	for _, prefix := range homeExcludePrefixes {
		if clean == prefix || strings.HasPrefix(clean, prefix+"/") {
			return true
		}
	}
	return false
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
