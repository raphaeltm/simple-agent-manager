package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type containerSnapshotTarget struct {
	containerID string
	workDir     string
	user        string
}

var errSnapshotArtifactLimit = errors.New("snapshot artifact exceeds configured limit")

type cappedBuffer struct {
	buffer   bytes.Buffer
	maxBytes int64
	exceeded bool
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	originalLen := len(p)
	remaining := b.maxBytes - int64(b.buffer.Len())
	if remaining <= 0 {
		b.exceeded = true
		return originalLen, nil
	}
	if int64(len(p)) > remaining {
		p = p[:remaining]
		b.exceeded = true
	}
	_, _ = b.buffer.Write(p)
	return originalLen, nil
}

type cappedFileWriter struct {
	file      *os.File
	remaining int64
	exceeded  bool
}

type containerSnapshotArchiveEntry struct {
	kind string
	size int64
	rel  string
}

func (w *cappedFileWriter) Write(p []byte) (int, error) {
	if w.remaining <= 0 {
		w.exceeded = true
		return 0, errSnapshotArtifactLimit
	}
	if int64(len(p)) > w.remaining {
		p = p[:w.remaining]
		w.exceeded = true
	}
	n, err := w.file.Write(p)
	w.remaining -= int64(n)
	if err != nil {
		return n, err
	}
	if w.exceeded {
		return n, errSnapshotArtifactLimit
	}
	return n, nil
}

func (s *Server) resolveContainerSnapshotTarget(runtime *WorkspaceRuntime) (*containerSnapshotTarget, error) {
	containerID, workDir, user, err := s.resolveContainerForWorkspace(runtime.ID)
	if err != nil {
		return nil, err
	}
	return &containerSnapshotTarget{containerID: containerID, workDir: workDir, user: user}, nil
}

func (s *Server) runSnapshotWorkspaceCommand(ctx context.Context, target *containerSnapshotTarget, extraEnv []string, args ...string) ([]byte, error) {
	cmd, err := s.workspaceExecCommandWithEnv(ctx, target.containerID, target.user, target.workDir, extraEnv, args...)
	if err != nil {
		return nil, err
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return nil, fmt.Errorf("workspace command %s failed: %s", args[0], message)
	}
	return stdout.Bytes(), nil
}

func (s *Server) runSnapshotWorkspaceCommandBounded(ctx context.Context, target *containerSnapshotTarget, maxOutputBytes int64, extraEnv []string, args ...string) ([]byte, error) {
	cmd, err := s.workspaceExecCommandWithEnv(ctx, target.containerID, target.user, target.workDir, extraEnv, args...)
	if err != nil {
		return nil, err
	}
	stdout := &cappedBuffer{maxBytes: maxOutputBytes}
	stderr := &cappedBuffer{maxBytes: 64 * 1024}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		message := strings.TrimSpace(stderr.buffer.String())
		if message == "" {
			message = err.Error()
		}
		return nil, fmt.Errorf("workspace command %s failed: %s", args[0], message)
	}
	if stdout.exceeded {
		return nil, fmt.Errorf("workspace command %s output exceeds snapshot inventory limit", args[0])
	}
	return stdout.buffer.Bytes(), nil
}

func (s *Server) removeContainerSnapshotPath(target *containerSnapshotTarget, path string) {
	_, _ = s.runSnapshotWorkspaceCommand(context.Background(), target, nil, "rm", "-f", "--", path)
}

func (s *Server) copyContainerSnapshotArtifact(ctx context.Context, target *containerSnapshotTarget, containerPath, localPattern string, maxBytes int64) (string, error) {
	statOutput, err := s.runSnapshotWorkspaceCommand(ctx, target, nil, "stat", "-c", "%s", "--", containerPath)
	if err != nil {
		return "", err
	}
	size, err := strconv.ParseInt(strings.TrimSpace(string(statOutput)), 10, 64)
	if err != nil || size < 0 {
		return "", fmt.Errorf("invalid container snapshot artifact size")
	}
	if maxBytes > 0 && size > maxBytes {
		return "", fmt.Errorf("snapshot artifact exceeds remaining budget: %d > %d", size, maxBytes)
	}

	file, err := os.CreateTemp("", localPattern)
	if err != nil {
		return "", err
	}
	localPath := file.Name()
	cmd, err := s.workspaceExecCommand(ctx, target.containerID, target.user, target.workDir, "cat", "--", containerPath)
	if err != nil {
		_ = file.Close()
		_ = os.Remove(localPath)
		return "", err
	}
	var stderr bytes.Buffer
	writer := &cappedFileWriter{file: file, remaining: maxBytes}
	cmd.Stdout = writer
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	closeErr := file.Close()
	if runErr != nil || closeErr != nil || writer.exceeded {
		_ = os.Remove(localPath)
		if writer.exceeded {
			return "", fmt.Errorf("snapshot artifact exceeds remaining budget")
		}
		if runErr != nil {
			return "", fmt.Errorf("copy container snapshot artifact: %w: %s", runErr, strings.TrimSpace(stderr.String()))
		}
		return "", closeErr
	}
	info, err := os.Stat(localPath)
	if err != nil || info.Size() != size {
		_ = os.Remove(localPath)
		return "", fmt.Errorf("container snapshot artifact size changed during copy")
	}
	return localPath, nil
}

func buildContainerHomeArchiveList(inventory []byte, entryThreshold, totalBudget int64) ([]byte, []snapshotSkippedEntry, int64, error) {
	return buildContainerSnapshotArchiveList(inventory, "", entryThreshold, totalBudget)
}

func buildContainerSnapshotArchiveList(inventory []byte, logicalName string, entryThreshold, totalBudget int64) ([]byte, []snapshotSkippedEntry, int64, error) {
	fields := bytes.Split(inventory, []byte{0})
	if len(fields) > 0 && len(fields[len(fields)-1]) == 0 {
		fields = fields[:len(fields)-1]
	}
	if len(fields)%4 != 0 {
		return nil, nil, 0, fmt.Errorf("invalid container HOME inventory")
	}
	if len(fields)/4 > defaultSnapshotMaxArchiveEntries {
		return nil, nil, 0, fmt.Errorf("container HOME inventory exceeds entry limit")
	}
	entries := make([]containerSnapshotArchiveEntry, 0, len(fields)/4)
	var skipped []snapshotSkippedEntry
	var selectedBytes int64
	for index := 0; index < len(fields); index += 4 {
		kind := string(fields[index])
		size, err := strconv.ParseInt(string(fields[index+1]), 10, 64)
		if err != nil || size < 0 {
			return nil, skipped, selectedBytes, fmt.Errorf("invalid container HOME entry size")
		}
		rel := filepath.ToSlash(filepath.Clean(string(fields[index+3])))
		if rel == "." || rel == ".." || filepath.IsAbs(rel) || strings.HasPrefix(rel, "../") {
			return nil, skipped, selectedBytes, fmt.Errorf("invalid container HOME entry path")
		}
		if shouldExcludeSnapshotRootPath(logicalName, rel) {
			continue
		}
		entries = append(entries, containerSnapshotArchiveEntry{kind: kind, size: size, rel: rel})
	}

	var selected bytes.Buffer
	selectedPaths := make(map[string]bool, len(entries))
	selectEntry := func(entry containerSnapshotArchiveEntry) error {
		if selectedPaths[entry.rel] {
			return nil
		}
		switch entry.kind {
		case "d":
			// Directory entries preserve modes and empty harness directories.
		case "f":
			if entry.size > entryThreshold {
				skipped = append(skipped, snapshotSkippedEntry{Path: snapshotDisplayPath(logicalName, entry.rel), Reason: "entry exceeds size threshold", SizeBytes: entry.size})
				return nil
			}
			if selectedBytes+entry.size > totalBudget {
				skipped = append(skipped, snapshotSkippedEntry{Path: snapshotDisplayPath(logicalName, entry.rel), Reason: "snapshot budget exhausted", SizeBytes: entry.size})
				return nil
			}
			selectedBytes += entry.size
		default:
			skipped = append(skipped, snapshotSkippedEntry{Path: snapshotDisplayPath(logicalName, entry.rel), Reason: "unsupported home entry type", SizeBytes: entry.size})
			return nil
		}
		selected.WriteString(entry.rel)
		selected.WriteByte(0)
		selectedPaths[entry.rel] = true
		return nil
	}
	for _, entry := range entries {
		if isHarnessSnapshotPath(logicalName, entry.rel) {
			if err := selectEntry(entry); err != nil {
				return nil, skipped, selectedBytes, err
			}
		}
	}
	for _, entry := range entries {
		if err := selectEntry(entry); err != nil {
			return nil, skipped, selectedBytes, err
		}
	}
	return selected.Bytes(), skipped, selectedBytes, nil
}

func isHarnessSnapshotPath(logicalName, rel string) bool {
	if logicalName != "" {
		return true
	}
	clean := filepath.ToSlash(filepath.Clean(rel))
	for _, prefix := range []string{".claude", ".codex", ".config/opencode", ".local/share/opencode", ".vibe"} {
		if clean == prefix || strings.HasPrefix(clean, prefix+"/") {
			return true
		}
	}
	return false
}

func containerHomeInventoryArgs(home string) []string {
	return containerSnapshotInventoryArgs(home, "")
}

func containerSnapshotInventoryArgs(root, logicalName string) []string {
	args := []string{"find", root, "-xdev", "-mindepth", "1", "("}
	prefixes := homeExcludePrefixes
	files := homeExcludeFiles
	if logicalName != "" {
		prefixes = snapshotRootExcludePrefixes[logicalName]
		files = snapshotRootExcludeFiles[logicalName]
	}
	for index, rel := range append(append([]string{}, prefixes...), mapKeys(files)...) {
		if index > 0 {
			args = append(args, "-o")
		}
		args = append(args, "-path", filepath.ToSlash(filepath.Join(root, rel)))
	}
	args = append(args, ")", "-prune", "-o", "-printf", "%y\\0%s\\0%m\\0%P\\0")
	return args
}

func mapKeys(values map[string]bool) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
