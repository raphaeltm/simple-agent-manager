package server

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
)

// ---------- Response types ----------

// GitFileStatus represents a single file in git status output.
type GitFileStatus struct {
	Path    string `json:"path"`
	Status  string `json:"status"`            // "M", "A", "D", "R", "??" etc.
	OldPath string `json:"oldPath,omitempty"` // populated for renames
}

// GitStatusResponse groups files by their git staging state.
type GitStatusResponse struct {
	Staged    []GitFileStatus `json:"staged"`
	Unstaged  []GitFileStatus `json:"unstaged"`
	Untracked []GitFileStatus `json:"untracked"`
}

// GitDiffResponse contains a unified diff for a single file.
type GitDiffResponse struct {
	Diff     string `json:"diff"`
	FilePath string `json:"filePath"`
}

// GitFileResponse contains the full content of a single file.
type GitFileResponse struct {
	Content  string `json:"content"`
	FilePath string `json:"filePath"`
}

// ---------- Handlers ----------

// handleGitStatus returns the git status for a workspace, grouped by staged/unstaged/untracked.
// GET /workspaces/{workspaceId}/git/status
func (s *Server) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	containerID, workDir, user, err := s.resolveContainerForWorkspace(workspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	workDir, err = s.resolveWorktreeWorkDir(r, workspaceID, containerID, user, workDir)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.config.GitExecTimeout)
	defer cancel()

	stdout, _, err := s.execInContainer(ctx, containerID, user, workDir, "git", "status", "--porcelain=v1")
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("git status failed: %v", err))
		return
	}

	staged, unstaged, untracked := parseGitStatusPorcelain(stdout)
	writeJSON(w, http.StatusOK, GitStatusResponse{
		Staged:    staged,
		Unstaged:  unstaged,
		Untracked: untracked,
	})
}

// handleGitDiff returns the unified diff for a single file.
// GET /workspaces/{workspaceId}/git/diff?path=...&staged=true|false
func (s *Server) handleGitDiff(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	filePath := r.URL.Query().Get("path")
	if filePath == "" {
		writeError(w, http.StatusBadRequest, "path query parameter is required")
		return
	}
	if err := sanitizeFilePath(filePath); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	staged := r.URL.Query().Get("staged") == "true"

	containerID, workDir, user, err := s.resolveContainerForWorkspace(workspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	workDir, err = s.resolveWorktreeWorkDir(r, workspaceID, containerID, user, workDir)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.config.GitExecTimeout)
	defer cancel()

	var diff string
	if staged {
		diff, _, err = s.execInContainer(ctx, containerID, user, workDir, "git", "diff", "--cached", "--", filePath)
	} else {
		diff, _, err = s.execInContainer(ctx, containerID, user, workDir, "git", "diff", "--", filePath)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("git diff failed: %v", err))
		return
	}

	// For untracked files, git diff returns empty. Show file content as all-additions.
	if diff == "" {
		content, _, catErr := s.execInContainer(ctx, containerID, user, workDir, "cat", filePath)
		if catErr == nil && content != "" {
			diff = formatAsAdditions(filePath, content)
		}
	}

	writeJSON(w, http.StatusOK, GitDiffResponse{
		Diff:     diff,
		FilePath: filePath,
	})
}

// handleGitFile returns the full content of a single file.
// GET /workspaces/{workspaceId}/git/file?path=...&ref=HEAD
func (s *Server) handleGitFile(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	filePath := r.URL.Query().Get("path")
	if filePath == "" {
		writeError(w, http.StatusBadRequest, "path query parameter is required")
		return
	}
	if err := sanitizeFilePath(filePath); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ref := r.URL.Query().Get("ref")

	containerID, workDir, user, err := s.resolveContainerForWorkspace(workspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	workDir, err = s.resolveWorktreeWorkDir(r, workspaceID, containerID, user, workDir)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.config.GitExecTimeout)
	defer cancel()

	var content string
	if ref != "" {
		// Sanitize ref to prevent command injection via git show argument
		if err := sanitizeGitRef(ref); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		content, _, err = s.execInContainer(ctx, containerID, user, workDir, "git", "show", ref+":"+filePath)
	} else {
		content, _, err = s.execInContainer(ctx, containerID, user, workDir, "cat", filePath)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("failed to read file: %v", err))
		return
	}

	// Enforce max file size
	if len(content) > s.config.GitFileMaxSize {
		writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("file exceeds maximum size of %d bytes", s.config.GitFileMaxSize))
		return
	}

	writeJSON(w, http.StatusOK, GitFileResponse{
		Content:  content,
		FilePath: filePath,
	})
}

// ---------- Helpers ----------

// sanitizeFilePath validates that a file path is safe for use in git commands.
// Rejects path traversal, absolute paths, and null bytes.
func sanitizeFilePath(path string) error {
	if path == "" {
		return fmt.Errorf("file path is empty")
	}

	if strings.ContainsRune(path, 0) {
		return fmt.Errorf("file path contains null byte")
	}

	if filepath.IsAbs(path) {
		return fmt.Errorf("absolute file paths are not allowed")
	}

	// Check for path traversal
	cleaned := filepath.Clean(path)
	if strings.HasPrefix(cleaned, "..") {
		return fmt.Errorf("path traversal is not allowed")
	}

	// Also reject any component that is ".."
	for _, part := range strings.Split(cleaned, string(filepath.Separator)) {
		if part == ".." {
			return fmt.Errorf("path traversal is not allowed")
		}
	}

	return nil
}

// sanitizeGitRef validates that a git ref string is safe (no shell metacharacters).
func sanitizeGitRef(ref string) error {
	if ref == "" {
		return fmt.Errorf("git ref is empty")
	}
	if strings.ContainsRune(ref, 0) {
		return fmt.Errorf("git ref contains null byte")
	}
	// Allow alphanumeric, -, _, /, ., ~ (standard git ref chars)
	for _, r := range ref {
		if !isValidRefChar(r) {
			return fmt.Errorf("invalid character in git ref: %c", r)
		}
	}
	return nil
}

func isValidRefChar(r rune) bool {
	if r >= 'a' && r <= 'z' {
		return true
	}
	if r >= 'A' && r <= 'Z' {
		return true
	}
	if r >= '0' && r <= '9' {
		return true
	}
	switch r {
	case '-', '_', '/', '.', '~', '^':
		return true
	}
	return false
}

// resolveContainerForWorkspace looks up the workspace runtime, validates its status,
// and resolves the devcontainer's container ID, work directory, and user.
func (s *Server) resolveContainerForWorkspace(workspaceID string) (containerID, workDir, user string, err error) {
	runtime, ok := s.getWorkspaceRuntime(workspaceID)
	if !ok {
		return "", "", "", fmt.Errorf("workspace not found")
	}
	if runtime.Status != "running" && runtime.Status != "recovery" {
		return "", "", "", fmt.Errorf("workspace is not running/recovery (status: %s)", runtime.Status)
	}

	resolver := s.ptyManagerContainerResolverForLabel(runtime.ContainerLabelValue)
	if resolver == nil {
		return "", "", "", fmt.Errorf("container mode is not enabled")
	}

	containerID, err = resolver()
	if err != nil {
		return "", "", "", fmt.Errorf("failed to resolve container: %w", err)
	}

	workDir = runtime.ContainerWorkDir
	if workDir == "" {
		workDir = "/workspaces"
	}

	user = strings.TrimSpace(runtime.ContainerUser)
	if user == "" {
		user = strings.TrimSpace(s.config.ContainerUser)
	}

	return containerID, workDir, user, nil
}

// execInContainer runs a command inside a devcontainer and returns stdout.
// Uses docker exec with optional user and workdir flags.
func (s *Server) execInContainer(ctx context.Context, containerID, user, workDir string, args ...string) (stdout string, stderr string, err error) {
	dockerArgs := []string{"exec", "-i"}
	if user != "" {
		dockerArgs = append(dockerArgs, "-u", user)
	}
	if workDir != "" {
		dockerArgs = append(dockerArgs, "-w", workDir)
	}
	dockerArgs = append(dockerArgs, containerID)
	dockerArgs = append(dockerArgs, args...)

	cmd := exec.CommandContext(ctx, "docker", dockerArgs...)

	var stdoutBuf, stderrBuf bytes.Buffer
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf

	if err := cmd.Run(); err != nil {
		stderrStr := strings.TrimSpace(stderrBuf.String())
		if stderrStr != "" {
			log.Printf("[git] exec error: %v, stderr: %s", err, stderrStr)
		}
		return "", stderrStr, fmt.Errorf("command failed: %w", err)
	}

	return stdoutBuf.String(), stderrBuf.String(), nil
}

// parseGitStatusPorcelain parses the output of `git status --porcelain=v1`
// into staged, unstaged, and untracked file lists.
//
// Porcelain v1 format: XY <path> (or XY <old> -> <new> for renames)
// X = index (staged) status, Y = worktree (unstaged) status.
// "??" = untracked, "!!" = ignored (skipped).
func parseGitStatusPorcelain(output string) (staged, unstaged, untracked []GitFileStatus) {
	staged = []GitFileStatus{}
	unstaged = []GitFileStatus{}
	untracked = []GitFileStatus{}

	lines := strings.Split(output, "\n")
	for _, line := range lines {
		if len(line) < 3 {
			continue
		}

		indexStatus := line[0]
		worktreeStatus := line[1]
		rest := line[3:] // skip "XY "

		// Handle renames: "old -> new"
		var filePath, oldPath string
		if arrowIdx := strings.Index(rest, " -> "); arrowIdx >= 0 {
			oldPath = strings.TrimSpace(rest[:arrowIdx])
			filePath = strings.TrimSpace(rest[arrowIdx+4:])
		} else {
			filePath = strings.TrimSpace(rest)
		}

		if filePath == "" {
			continue
		}

		// Untracked
		if indexStatus == '?' && worktreeStatus == '?' {
			untracked = append(untracked, GitFileStatus{
				Path:   filePath,
				Status: "??",
			})
			continue
		}

		// Ignored
		if indexStatus == '!' && worktreeStatus == '!' {
			continue
		}

		// Staged changes (index status is not space and not '?')
		if indexStatus != ' ' && indexStatus != '?' {
			fs := GitFileStatus{
				Path:   filePath,
				Status: string(indexStatus),
			}
			if oldPath != "" {
				fs.OldPath = oldPath
			}
			staged = append(staged, fs)
		}

		// Unstaged changes (worktree status is not space and not '?')
		if worktreeStatus != ' ' && worktreeStatus != '?' {
			unstaged = append(unstaged, GitFileStatus{
				Path:   filePath,
				Status: string(worktreeStatus),
			})
		}
	}

	return staged, unstaged, untracked
}

// formatAsAdditions converts file content into a unified diff format where all lines are additions.
// Used for untracked files where `git diff` returns empty.
func formatAsAdditions(filePath, content string) string {
	var b strings.Builder
	b.WriteString(fmt.Sprintf("--- /dev/null\n+++ b/%s\n", filePath))

	lines := strings.Split(content, "\n")
	// Remove trailing empty line from Split
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}

	b.WriteString(fmt.Sprintf("@@ -0,0 +1,%d @@\n", len(lines)))
	for _, line := range lines {
		b.WriteString("+" + line + "\n")
	}

	return b.String()
}
