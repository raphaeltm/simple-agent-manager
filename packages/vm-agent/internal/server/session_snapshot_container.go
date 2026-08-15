package server

import (
	"archive/tar"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func (s *Server) resolveContainerSnapshotArchiveRoots(ctx context.Context, target *containerSnapshotTarget) ([]snapshotArchiveRoot, error) {
	homeOutput, err := s.runSnapshotWorkspaceCommand(ctx, target, nil, "printenv", "HOME")
	if err != nil {
		return nil, fmt.Errorf("resolve container HOME: %w", err)
	}
	home := filepath.Clean(strings.TrimSpace(string(homeOutput)))
	if !filepath.IsAbs(home) || home == string(filepath.Separator) {
		return nil, fmt.Errorf("unsafe container HOME %q", home)
	}
	envValues := make(map[string]string)
	for _, key := range []string{"CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_DATA_HOME"} {
		output, envErr := s.runSnapshotWorkspaceCommand(ctx, target, nil, "printenv", key)
		if envErr == nil {
			envValues[key] = strings.TrimSpace(string(output))
		}
	}
	candidates, err := externalSnapshotRootCandidates(home, func(key string) string { return envValues[key] })
	if err != nil {
		return nil, err
	}
	roots := []snapshotArchiveRoot{{path: home}}
	for _, candidate := range candidates {
		if candidate.path == "" || pathWithinRoot(home, candidate.path) {
			continue
		}
		kind, statErr := s.runSnapshotWorkspaceCommand(ctx, target, nil, "stat", "-c", "%F", "--", candidate.path)
		if statErr != nil {
			// An unused harness commonly has no state root. Only roots present in the
			// runtime are included; the active harness root necessarily exists after
			// it has produced a resumable session.
			continue
		}
		if strings.TrimSpace(string(kind)) != "directory" {
			return nil, fmt.Errorf("container %s snapshot state root is not a directory", candidate.logicalName)
		}
		roots = append(roots, candidate)
	}
	return roots, nil
}

func (s *Server) createContainerHomeTar(ctx context.Context, target *containerSnapshotTarget, entryThreshold, totalBudget int64) (string, []snapshotSkippedEntry, error) {
	roots, err := s.resolveContainerSnapshotArchiveRoots(ctx, target)
	if err != nil {
		return "", nil, err
	}
	containerPath := "/tmp/sam-session-home-" + randomEventID() + ".tar"
	defer s.removeContainerSnapshotPath(target, containerPath)
	var skipped []snapshotSkippedEntry
	var selectedBytes int64
	for index, root := range roots {
		inventory, inventoryErr := s.runSnapshotWorkspaceCommandBounded(ctx, target, defaultSnapshotInventoryMaxBytes, nil, containerSnapshotInventoryArgs(root.path, root.logicalName)...)
		if inventoryErr != nil {
			return "", skipped, fmt.Errorf("inventory container snapshot root %q: %w", root.logicalName, inventoryErr)
		}
		fileList, rootSkipped, rootBytes, listErr := buildContainerSnapshotArchiveList(inventory, root.logicalName, entryThreshold, totalBudget-selectedBytes)
		skipped = append(skipped, rootSkipped...)
		if listErr != nil {
			return "", skipped, listErr
		}
		selectedBytes += rootBytes
		mode := "-rf"
		if index == 0 {
			mode = "-cf"
		}
		args := containerSnapshotTarArgs(root, mode, containerPath)
		cmd, commandErr := s.workspaceExecCommand(ctx, target.containerID, target.user, target.workDir, args...)
		if commandErr != nil {
			return "", skipped, commandErr
		}
		cmd.Stdin = bytes.NewReader(fileList)
		stderr := &cappedBuffer{maxBytes: 64 * 1024}
		cmd.Stderr = stderr
		if commandErr := cmd.Run(); commandErr != nil {
			return "", skipped, fmt.Errorf("archive container snapshot root %q: %w: %s", root.logicalName, commandErr, strings.TrimSpace(stderr.buffer.String()))
		}
	}
	path, err := s.copyContainerSnapshotArtifact(ctx, target, containerPath, "sam-session-home-*.tar", totalBudget)
	if err != nil {
		return "", skipped, err
	}
	if _, err := validateSnapshotHomeTar(path, entryThreshold, totalBudget); err != nil {
		_ = os.Remove(path)
		return "", skipped, fmt.Errorf("validate generated container HOME archive: %w", err)
	}
	return path, skipped, nil
}

func containerSnapshotTarArgs(root snapshotArchiveRoot, mode, containerPath string) []string {
	args := []string{"tar", "--hard-dereference", "--null", "--verbatim-files-from", "--no-recursion", "-C", root.path}
	if root.logicalName != "" {
		args = append(args, "--transform", "s,^,"+snapshotExternalRootsPrefix+"/"+root.logicalName+"/,")
	}
	return append(args, mode, containerPath, "-T", "-")
}

func (s *Server) writeHostSnapshotArtifactToContainer(ctx context.Context, target *containerSnapshotTarget, hostPath, containerPath string) error {
	file, err := os.Open(hostPath)
	if err != nil {
		return err
	}
	defer file.Close()
	cmd, err := s.workspaceExecCommand(ctx, target.containerID, target.user, target.workDir, "tee", "--", containerPath)
	if err != nil {
		return err
	}
	cmd.Stdin = file
	cmd.Stdout = io.Discard
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("copy snapshot artifact into container: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

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
	excluded := snapshotPathSet(excludedPaths)
	output, err := s.runSnapshotWorkspaceCommand(ctx, target, nil, "git", "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil || len(output) == 0 {
		return nil
	}
	var skipped []snapshotSkippedEntry
	for _, raw := range bytes.Split(output, []byte{0}) {
		if len(raw) == 0 {
			continue
		}
		path := filepath.ToSlash(filepath.Clean(string(raw)))
		if excluded[path] {
			continue
		}
		statOutput, statErr := s.runSnapshotWorkspaceCommand(ctx, target, nil, "stat", "-c", "%s", "--", path)
		if statErr != nil {
			continue
		}
		size, parseErr := strconv.ParseInt(strings.TrimSpace(string(statOutput)), 10, 64)
		if parseErr != nil || size <= threshold {
			continue
		}
		skipped = append(skipped, snapshotSkippedEntry{Path: path, Reason: "entry exceeds size threshold", SizeBytes: size})
		_, _ = s.containerGit(ctx, target, []string{"GIT_INDEX_FILE=" + syntheticIndex}, "reset", "--", path)
	}
	return skipped
}

func (s *Server) oversizedContainerIndexEntries(ctx context.Context, target *containerSnapshotTarget, threshold int64, excludedPaths []string) []snapshotSkippedEntry {
	excluded := snapshotPathSet(excludedPaths)
	output, err := s.runSnapshotWorkspaceCommand(ctx, target, nil, "git", "ls-files", "-s", "-z")
	if err != nil || len(output) == 0 {
		return nil
	}
	var skipped []snapshotSkippedEntry
	for _, raw := range bytes.Split(output, []byte{0}) {
		if len(raw) == 0 {
			continue
		}
		meta, path, found := strings.Cut(string(raw), "\t")
		fields := strings.Fields(meta)
		if !found || path == "" || len(fields) < 2 {
			continue
		}
		path = filepath.ToSlash(filepath.Clean(path))
		if excluded[path] {
			continue
		}
		sizeOutput, sizeErr := s.containerGit(ctx, target, nil, "cat-file", "-s", fields[1])
		if sizeErr != nil {
			continue
		}
		size, parseErr := strconv.ParseInt(sizeOutput, 10, 64)
		if parseErr != nil || size <= threshold {
			continue
		}
		skipped = append(skipped, snapshotSkippedEntry{Path: path, Reason: "staged entry exceeds size threshold", SizeBytes: size})
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

func (s *Server) createContainerWIPBundle(ctx context.Context, target *containerSnapshotTarget, entryThreshold, maxBytes int64) (string, string, []snapshotSkippedEntry, error) {
	present, err := s.containerGit(ctx, target, nil, "rev-parse", "--is-inside-work-tree")
	if err != nil || present != "true" {
		return "", "", nil, nil
	}
	if s.containerGitOperationInProgress(ctx, target) {
		return "", "", []snapshotSkippedEntry{{Path: target.workDir, Reason: "git operation in progress"}}, nil
	}
	base, err := s.containerGit(ctx, target, nil, "rev-parse", "HEAD")
	if err != nil {
		return "", "", nil, fmt.Errorf("resolve container snapshot base commit: %w", err)
	}
	status, err := s.containerGit(ctx, target, nil, "status", "--porcelain")
	if err != nil {
		return base, "", nil, fmt.Errorf("container git status: %w", err)
	}
	if status == "" {
		return base, "", nil, nil
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
	if _, err := s.containerGit(ctx, target, nil, "bundle", "create", containerBundle, worktreeRef, indexRef); err != nil {
		return base, "", skipped, fmt.Errorf("create container git bundle: %w", err)
	}
	localPath, err := s.copyContainerSnapshotArtifact(ctx, target, containerBundle, "sam-session-wip-*.bundle", maxBytes)
	if err != nil {
		return base, "", skipped, err
	}
	return base, localPath, skipped, nil
}

func (s *Server) downloadSnapshotArtifactToTemp(ctx context.Context, downloadPath, token string, idleTimeout time.Duration, pattern string, maxBytes int64) (string, error) {
	res, err := s.snapshotDownload(ctx, downloadPath, token)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.ContentLength > maxBytes && maxBytes > 0 {
		return "", fmt.Errorf("snapshot artifact exceeds restore budget")
	}
	file, err := os.CreateTemp("", pattern)
	if err != nil {
		return "", err
	}
	path := file.Name()
	reader := io.Reader(newIdleReader(res.Body, idleTimeout))
	if maxBytes > 0 {
		reader = io.LimitReader(reader, maxBytes+1)
	}
	written, copyErr := io.Copy(file, reader)
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil || (maxBytes > 0 && written > maxBytes) {
		_ = os.Remove(path)
		if copyErr != nil {
			return "", copyErr
		}
		if closeErr != nil {
			return "", closeErr
		}
		return "", fmt.Errorf("snapshot artifact exceeds restore budget")
	}
	return path, nil
}

func validateSnapshotHomeTar(path string, entryThreshold, totalBudget int64) ([]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	reader := tar.NewReader(file)
	var names []string
	var total int64
	seen := make(map[string]byte)
	requiredDirectories := make(map[string]bool)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			return names, nil
		}
		if err != nil {
			return nil, err
		}
		name := filepath.ToSlash(filepath.Clean(header.Name))
		if name == "." || name == ".." || filepath.IsAbs(name) || strings.HasPrefix(name, "../") {
			return nil, fmt.Errorf("snapshot HOME archive contains unsafe path")
		}
		logicalName, relativeName, external, locationErr := snapshotArchiveLocation(name)
		if locationErr != nil {
			return nil, locationErr
		}
		if (!external && shouldExcludeHomePath(name)) || (external && relativeName != "." && shouldExcludeSnapshotRootPath(logicalName, relativeName)) {
			return nil, fmt.Errorf("snapshot HOME archive contains excluded path %q", name)
		}
		if header.Typeflag != tar.TypeDir && header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA {
			return nil, fmt.Errorf("snapshot HOME archive contains unsupported entry %q", name)
		}
		if _, duplicate := seen[name]; duplicate {
			return nil, fmt.Errorf("snapshot HOME archive contains duplicate entry %q", name)
		}
		for parent := filepath.ToSlash(filepath.Dir(name)); parent != "." && parent != "/"; parent = filepath.ToSlash(filepath.Dir(parent)) {
			if parentKind, exists := seen[parent]; exists && (parentKind == tar.TypeReg || parentKind == tar.TypeRegA) {
				return nil, fmt.Errorf("snapshot HOME archive entry %q descends through regular file %q", name, parent)
			}
			requiredDirectories[parent] = true
		}
		if (header.Typeflag == tar.TypeReg || header.Typeflag == tar.TypeRegA) && requiredDirectories[name] {
			return nil, fmt.Errorf("snapshot HOME archive regular file %q conflicts with child entries", name)
		}
		if header.Size < 0 || (entryThreshold > 0 && header.Size > entryThreshold) {
			return nil, fmt.Errorf("snapshot HOME entry exceeds restore threshold")
		}
		total += header.Size
		if totalBudget > 0 && total > totalBudget {
			return nil, fmt.Errorf("snapshot HOME contents exceed restore budget")
		}
		seen[name] = header.Typeflag
		names = append(names, name)
		if len(names) > defaultSnapshotMaxArchiveEntries {
			return nil, fmt.Errorf("snapshot HOME archive exceeds entry limit")
		}
	}
}

func snapshotArchiveLocation(name string) (logicalName, relativeName string, external bool, err error) {
	if name != snapshotExternalRootsPrefix && !strings.HasPrefix(name, snapshotExternalRootsPrefix+"/") {
		return "", name, false, nil
	}
	parts := strings.Split(name, "/")
	if len(parts) < 2 || parts[0] != snapshotExternalRootsPrefix {
		return "", "", false, fmt.Errorf("snapshot HOME archive contains invalid reserved namespace entry %q", name)
	}
	logicalName = parts[1]
	if logicalName != snapshotRootCodex && logicalName != snapshotRootClaude && logicalName != snapshotRootOpenCode {
		return "", "", false, fmt.Errorf("snapshot HOME archive contains unknown external root %q", logicalName)
	}
	relativeName = "."
	if len(parts) > 2 {
		relativeName = strings.Join(parts[2:], "/")
	}
	return logicalName, relativeName, true, nil
}

func snapshotTargetTraversesSymlink(names []string, symlinks []byte) bool {
	for _, raw := range bytes.Split(symlinks, []byte{0}) {
		link := filepath.ToSlash(filepath.Clean(string(raw)))
		if link == "." || link == "" {
			continue
		}
		for _, name := range names {
			if name == link || strings.HasPrefix(name, link+"/") {
				return true
			}
		}
	}
	return false
}

func (s *Server) downloadAndExtractContainerHome(ctx context.Context, target *containerSnapshotTarget, downloadPath, token string, idleTimeout time.Duration, entryThreshold, totalBudget int64) error {
	path, err := s.downloadSnapshotArtifactToTemp(ctx, downloadPath, token, idleTimeout, "sam-session-restore-home-*.tar", totalBudget)
	if err != nil {
		return err
	}
	defer os.Remove(path)
	names, err := validateSnapshotHomeTar(path, entryThreshold, totalBudget)
	if err != nil {
		return err
	}
	destinations, err := s.resolveContainerSnapshotRestoreDestinations(ctx, target)
	if err != nil {
		return err
	}
	for _, logicalName := range []string{"", snapshotRootCodex, snapshotRootClaude, snapshotRootOpenCode} {
		destination, exists := destinations[logicalName]
		if !exists {
			for _, name := range names {
				rootName, _, external, _ := snapshotArchiveLocation(name)
				if external && rootName == logicalName {
					return fmt.Errorf("restored runtime does not define %s state destination", logicalName)
				}
			}
			continue
		}
		subsetPath, subsetNames, subsetErr := writeSnapshotArchiveSubset(path, logicalName)
		if subsetErr != nil {
			return subsetErr
		}
		if subsetPath == "" {
			continue
		}
		extractErr := s.extractContainerSnapshotSubset(ctx, target, destination, subsetPath, subsetNames)
		_ = os.Remove(subsetPath) // NOSONAR gosecurity:S6096 -- subsetPath is generated exclusively by os.CreateTemp, never from an archive entry
		if extractErr != nil {
			return extractErr
		}
	}
	return nil
}

func (s *Server) resolveContainerSnapshotRestoreDestinations(ctx context.Context, target *containerSnapshotTarget) (map[string]string, error) {
	homeOutput, err := s.runSnapshotWorkspaceCommand(ctx, target, nil, "printenv", "HOME")
	if err != nil {
		return nil, fmt.Errorf("resolve restored container HOME: %w", err)
	}
	home := filepath.Clean(strings.TrimSpace(string(homeOutput)))
	if !filepath.IsAbs(home) || home == string(filepath.Separator) {
		return nil, fmt.Errorf("unsafe restored container HOME %q", home)
	}
	envValues := make(map[string]string)
	for _, key := range []string{"CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_DATA_HOME"} {
		output, envErr := s.runSnapshotWorkspaceCommand(ctx, target, nil, "printenv", key)
		if envErr == nil {
			envValues[key] = strings.TrimSpace(string(output))
		}
	}
	candidates, err := externalSnapshotRootCandidates(home, func(key string) string { return envValues[key] })
	if err != nil {
		return nil, err
	}
	destinations := map[string]string{"": home}
	for _, candidate := range candidates {
		if candidate.path != "" {
			destinations[candidate.logicalName] = candidate.path
		}
	}
	return destinations, nil
}

func writeSnapshotArchiveSubset(sourcePath, logicalName string) (string, []string, error) {
	source, err := os.Open(sourcePath)
	if err != nil {
		return "", nil, err
	}
	defer source.Close()
	tmp, err := os.CreateTemp("", "sam-session-restore-subset-*.tar")
	if err != nil {
		return "", nil, err
	}
	tmpPath := tmp.Name()
	writer := tar.NewWriter(tmp)
	reader := tar.NewReader(source)
	var names []string
	for {
		header, nextErr := reader.Next()
		if nextErr == io.EOF {
			break
		}
		if nextErr != nil {
			err = nextErr
			break
		}
		name := filepath.ToSlash(filepath.Clean(header.Name))
		rootName, relativeName, external, locationErr := snapshotArchiveLocation(name)
		if locationErr != nil {
			err = locationErr
			break
		}
		if logicalName == "" {
			if external {
				continue
			}
			relativeName = name
		} else if !external || rootName != logicalName {
			continue
		}
		if relativeName == "." {
			continue
		}
		copyHeader := *header
		copyHeader.Name = relativeName
		copyHeader.Linkname = ""
		if headerErr := writer.WriteHeader(&copyHeader); headerErr != nil {
			err = headerErr
			break
		}
		if header.Typeflag == tar.TypeReg || header.Typeflag == tar.TypeRegA {
			if _, copyErr := io.Copy(writer, reader); copyErr != nil {
				err = copyErr
				break
			}
		}
		names = append(names, relativeName)
	}
	if closeErr := writer.Close(); err == nil {
		err = closeErr
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil || len(names) == 0 {
		_ = os.Remove(tmpPath) // NOSONAR gosecurity:S6096 -- tmpPath is generated exclusively by os.CreateTemp, never from an archive entry
		return "", names, err
	}
	return tmpPath, names, nil
}

func (s *Server) extractContainerSnapshotSubset(ctx context.Context, target *containerSnapshotTarget, destination, subsetPath string, names []string) error {
	if err := s.ensureSafeContainerSnapshotDestination(ctx, target, destination); err != nil {
		return err
	}
	symlinks, err := s.runSnapshotWorkspaceCommandBounded(ctx, target, defaultSnapshotInventoryMaxBytes, nil, "find", destination, "-xdev", "-type", "l", "-printf", "%P\\0")
	if err != nil {
		return fmt.Errorf("inspect restored container snapshot destination symlinks: %w", err)
	}
	if snapshotTargetTraversesSymlink(names, symlinks) {
		return fmt.Errorf("snapshot target traverses an existing symlink")
	}
	file, err := os.Open(subsetPath) // NOSONAR gosecurity:S6096 -- subsetPath is generated exclusively by os.CreateTemp after full archive validation
	if err != nil {
		return err
	}
	defer file.Close()
	cmd, err := s.workspaceExecCommand(ctx, target.containerID, target.user, target.workDir,
		"tar", "--no-same-owner", "--no-same-permissions", "-C", destination, "-xf", "-")
	if err != nil {
		return err
	}
	cmd.Stdin = file
	stderr := &cappedBuffer{maxBytes: 64 * 1024}
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("extract restored container snapshot state: %w: %s", err, strings.TrimSpace(stderr.buffer.String()))
	}
	return nil
}

func (s *Server) ensureSafeContainerSnapshotDestination(ctx context.Context, target *containerSnapshotTarget, destination string) error {
	if !filepath.IsAbs(destination) || filepath.Clean(destination) == string(filepath.Separator) {
		return fmt.Errorf("unsafe container snapshot destination %q", destination)
	}
	if err := s.rejectContainerSnapshotDestinationSymlinks(ctx, target, destination); err != nil {
		return err
	}
	if _, err := s.runSnapshotWorkspaceCommand(ctx, target, nil, "mkdir", "-p", "--", destination); err != nil {
		return fmt.Errorf("create restored container snapshot destination: %w", err)
	}
	return s.rejectContainerSnapshotDestinationSymlinks(ctx, target, destination)
}

func (s *Server) rejectContainerSnapshotDestinationSymlinks(ctx context.Context, target *containerSnapshotTarget, destination string) error {
	current := string(filepath.Separator)
	for _, part := range strings.Split(strings.TrimPrefix(filepath.Clean(destination), string(filepath.Separator)), string(filepath.Separator)) {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		kind, err := s.runSnapshotWorkspaceCommand(ctx, target, nil, "stat", "-c", "%F", "--", current)
		if err != nil {
			return nil
		}
		kindText := strings.TrimSpace(string(kind))
		if kindText == "symbolic link" {
			return fmt.Errorf("container snapshot destination traverses symlink: %s", current)
		}
		if kindText != "directory" {
			return fmt.Errorf("container snapshot destination traverses non-directory: %s", current)
		}
	}
	return nil
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
	worktreeRef, worktreeCommit := snapshotBundleRef(refs, "/worktree")
	indexRef, indexCommit := snapshotBundleRef(refs, "/index")
	if worktreeRef != "" && indexRef != "" {
		if output, err := s.containerGit(ctx, target, nil, "fetch", containerPath, worktreeRef, indexRef); err != nil {
			return fmt.Errorf("fetch container snapshot bundle: %w: %s", err, output)
		}
		if output, err := s.containerGit(ctx, target, nil, "read-tree", "--reset", "-u", worktreeCommit); err != nil {
			return fmt.Errorf("materialize container snapshot worktree: %w: %s", err, output)
		}
		if strings.TrimSpace(baseCommit) != "" {
			if output, err := s.containerGit(ctx, target, nil, "reset", "--soft", baseCommit); err != nil {
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
	if output, err := s.containerGit(ctx, target, nil, "read-tree", "--reset", "-u", "FETCH_HEAD"); err != nil {
		return fmt.Errorf("materialize legacy container snapshot tree: %w: %s", err, output)
	}
	if strings.TrimSpace(baseCommit) != "" {
		if output, err := s.containerGit(ctx, target, nil, "reset", "--mixed", baseCommit); err != nil {
			return fmt.Errorf("restore legacy container snapshot base: %w: %s", err, output)
		}
	}
	return nil
}
