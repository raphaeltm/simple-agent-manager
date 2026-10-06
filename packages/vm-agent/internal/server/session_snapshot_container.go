package server

import (
	"archive/tar"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
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
	var externalRoots []snapshotArchiveRoot
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
		externalRoots = append(externalRoots, candidate)
	}
	return append(externalRoots, snapshotArchiveRoot{path: home}), nil
}

func (s *Server) createContainerHomeTar(ctx context.Context, target *containerSnapshotTarget, entryThreshold, totalBudget int64, reportProgress func(context.Context, string)) (string, []snapshotSkippedEntry, error) {
	roots, err := s.resolveContainerSnapshotArchiveRoots(ctx, target)
	if err != nil {
		return "", nil, err
	}
	containerPath := "/tmp/sam-session-home-" + randomEventID() + ".tar"
	defer s.removeContainerSnapshotPath(target, containerPath)
	var skipped []snapshotSkippedEntry
	var selectedBytes int64
	for index, root := range roots {
		if reportProgress != nil {
			reportProgress(ctx, "home-walk")
		}
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
		if reportProgress != nil {
			reportProgress(ctx, "home-walk")
		}
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
		if reportProgress != nil {
			reportProgress(ctx, "home-copy")
		}
		if commandErr := cmd.Run(); commandErr != nil {
			return "", skipped, fmt.Errorf("archive container snapshot root %q: %w: %s", root.logicalName, commandErr, strings.TrimSpace(stderr.buffer.String()))
		}
		if reportProgress != nil {
			reportProgress(ctx, "home-copy")
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
