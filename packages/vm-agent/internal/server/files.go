package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"mime"
	"net/http"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// FileEntry represents a single file or directory in a listing.
type FileEntry struct {
	Name       string `json:"name"`
	Type       string `json:"type"`       // "file", "dir", "symlink"
	Size       int64  `json:"size"`       // bytes, 0 for dirs
	ModifiedAt string `json:"modifiedAt"` // ISO 8601
}

// FileListResponse is the response from the file listing endpoint.
type FileListResponse struct {
	Path    string      `json:"path"`
	Entries []FileEntry `json:"entries"`
}

// handleFileList handles GET /workspaces/{workspaceId}/files/list?path=...
// Returns a flat directory listing with type, size, and modification time.
func (s *Server) handleFileList(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		http.Error(w, `{"error":"missing workspaceId"}`, http.StatusBadRequest)
		return
	}

	// Auth: reuse the same pattern as git endpoints
	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	// Sanitize path
	dirPath := r.URL.Query().Get("path")
	if dirPath == "" {
		dirPath = "."
	}
	if dirPath != "." {
		if err := sanitizeFilePath(dirPath); err != nil {
			http.Error(w, fmt.Sprintf(`{"error":"invalid path: %s"}`, err.Error()), http.StatusBadRequest)
			return
		}
	}

	// Resolve container
	containerID, workDir, user, err := s.resolveContainerForWorkspace(workspaceID)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusInternalServerError)
		return
	}
	workDir, err = s.resolveWorktreeWorkDir(r, workspaceID, containerID, user, workDir)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusBadRequest)
		return
	}

	// Use find with -maxdepth 1 to list directory contents.
	// Output format: type\tsize\tmtime_epoch\tname (tab-separated)
	// -not -name '.' excludes the directory itself from output.
	maxEntries := s.config.FileListMaxEntries
	findCmd := fmt.Sprintf(
		`find %q -maxdepth 1 -not -name '.' -printf '%%y\t%%s\t%%T@\t%%f\n' 2>/dev/null | head -n %d`,
		dirPath, maxEntries,
	)

	timeout := s.config.FileListTimeout
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()

	output, _, err := s.execInContainer(ctx, containerID, user, workDir, "sh", "-c", findCmd)
	if err != nil {
		slog.Error("Error listing directory", "path", dirPath, "workspace", workspaceID, "error", err)
		http.Error(w, `{"error":"failed to list directory"}`, http.StatusInternalServerError)
		return
	}

	entries := parseFileListOutput(output)

	// Sort: dirs first, then alphabetically by name
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Type != entries[j].Type {
			return entries[i].Type == "dir"
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})

	resp := FileListResponse{
		Path:    dirPath,
		Entries: entries,
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		slog.Error("Error encoding file list response", "error", err)
	}
}

// FileFindResponse is the response from the recursive file find endpoint.
type FileFindResponse struct {
	Files []string `json:"files"`
}

// handleFileFind handles GET /workspaces/{workspaceId}/files/find
// Returns a flat list of all file paths (relative to workdir), excluding
// common noise directories (node_modules, .git, dist, etc.).
func (s *Server) handleFileFind(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		http.Error(w, `{"error":"missing workspaceId"}`, http.StatusBadRequest)
		return
	}

	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	containerID, workDir, user, err := s.resolveContainerForWorkspace(workspaceID)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusInternalServerError)
		return
	}
	workDir, err = s.resolveWorktreeWorkDir(r, workspaceID, containerID, user, workDir)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusBadRequest)
		return
	}

	maxEntries := s.config.FileFindMaxEntries
	// Exclude common noise directories and files
	findCmd := fmt.Sprintf(
		`find . -type f `+
			`-not -path '*/node_modules/*' `+
			`-not -path '*/.git/*' `+
			`-not -path '*/dist/*' `+
			`-not -path '*/.next/*' `+
			`-not -path '*/coverage/*' `+
			`-not -path '*/__pycache__/*' `+
			`-not -path '*/.DS_Store' `+
			`-not -path '*/vendor/*' `+
			`-not -name '*.pyc' `+
			`2>/dev/null | head -n %d`,
		maxEntries,
	)

	timeout := s.config.FileFindTimeout
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()

	output, _, err := s.execInContainer(ctx, containerID, user, workDir, "sh", "-c", findCmd)
	if err != nil {
		slog.Error("Error finding files", "workspace", workspaceID, "error", err)
		http.Error(w, `{"error":"failed to find files"}`, http.StatusInternalServerError)
		return
	}

	files := parseFileFindOutput(output)

	resp := FileFindResponse{Files: files}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		slog.Error("Error encoding file find response", "error", err)
	}
}

// parseFileFindOutput parses the output of find -type f, one path per line.
// Strips the leading "./" prefix from each path.
func parseFileFindOutput(output string) []string {
	if strings.TrimSpace(output) == "" {
		return []string{}
	}

	lines := strings.Split(strings.TrimRight(output, "\n"), "\n")
	files := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// Strip leading ./
		if strings.HasPrefix(line, "./") {
			line = line[2:]
		}
		files = append(files, line)
	}
	return files
}

// handleFileRaw serves raw binary file content with proper Content-Type.
// GET /workspaces/{workspaceId}/files/raw?path=...
// Streams the file directly from the container via docker exec cat.
func (s *Server) handleFileRaw(w http.ResponseWriter, r *http.Request) {
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

	ctx, cancel := context.WithTimeout(r.Context(), s.config.FileRawTimeout)
	defer cancel()

	// Stat the file to get type, size, and mtime. Uses direct args (no shell)
	// to avoid injection. Format: file_type\tsize_bytes\tmtime_epoch
	statOut, statStderr, statErr := s.execInContainer(ctx, containerID, user, workDir,
		"stat", "-c", "%F\t%s\t%Y", filePath)
	if statErr != nil {
		slog.Warn("stat failed for raw file",
			"path", filePath, "workspace", workspaceID,
			"stderr", statStderr, "error", statErr)
		writeError(w, http.StatusNotFound, "file not found")
		return
	}

	statOut = strings.TrimSpace(statOut)
	statParts := strings.SplitN(statOut, "\t", 3)
	if len(statParts) < 3 {
		writeError(w, http.StatusInternalServerError, "failed to stat file")
		return
	}

	// Reject non-regular files (directories, symlinks, FIFOs, etc.)
	fileType := statParts[0]
	if fileType != "regular file" && fileType != "regular empty file" {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("not a regular file (type: %s)", fileType))
		return
	}

	fileSize, err := strconv.ParseInt(statParts[1], 10, 64)
	if err != nil {
		slog.Error("failed to parse file size", "raw", statParts[1], "error", err)
		writeError(w, http.StatusInternalServerError, "failed to parse file metadata")
		return
	}
	fileMtime, err := strconv.ParseInt(statParts[2], 10, 64)
	if err != nil {
		slog.Error("failed to parse file mtime", "raw", statParts[2], "error", err)
		writeError(w, http.StatusInternalServerError, "failed to parse file metadata")
		return
	}

	// Enforce max file size
	if fileSize > int64(s.config.FileRawMaxSize) {
		writeError(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("file exceeds maximum size of %d bytes", s.config.FileRawMaxSize))
		return
	}

	// Build ETag from mtime and size
	etag := fmt.Sprintf(`"%x-%x"`, fileMtime, fileSize)

	// Check If-None-Match for 304 support
	if match := r.Header.Get("If-None-Match"); match == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	// Detect MIME type from file extension
	ext := filepath.Ext(filePath)
	contentType := mime.TypeByExtension(ext)
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	// Set response headers before streaming.
	// Intentionally omit Content-Length: the stat and cat are not atomic,
	// so the file could change between them. Chunked transfer encoding is safer.
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("ETag", etag)
	w.Header().Set("X-Content-Type-Options", "nosniff")

	// For SVG files, add restrictive CSP to prevent script execution
	if strings.HasPrefix(contentType, "image/svg") {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
	}

	// Stream the file content directly from docker exec to the response writer.
	// This avoids buffering the entire file in memory.
	// Uses direct args (no shell) — cat receives filePath as a single argument.
	dockerArgs := []string{"exec", "-i"}
	if user != "" {
		dockerArgs = append(dockerArgs, "-u", user)
	}
	if workDir != "" {
		dockerArgs = append(dockerArgs, "-w", workDir)
	}
	dockerArgs = append(dockerArgs, containerID, "cat", "--", filePath)

	cmd := exec.CommandContext(ctx, "docker", dockerArgs...)
	cmd.Stdout = w
	var stderrBuf bytes.Buffer
	cmd.Stderr = &stderrBuf

	if err := cmd.Run(); err != nil {
		// If we already started writing, we can't send an error response.
		// Log and return — the client will see a truncated response.
		slog.Error("Error streaming raw file",
			"path", filePath,
			"workspace", workspaceID,
			"error", err,
			"stderr", strings.TrimSpace(stderrBuf.String()),
		)
	}
}

// parseFileListOutput parses the output of find -printf '%y\t%s\t%T@\t%f\n'
// Each line: type(d/f/l)\tsize\tmtime_epoch\tname
func parseFileListOutput(output string) []FileEntry {
	if strings.TrimSpace(output) == "" {
		return []FileEntry{}
	}

	lines := strings.Split(strings.TrimRight(output, "\n"), "\n")
	entries := make([]FileEntry, 0, len(lines))

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		parts := strings.SplitN(line, "\t", 4)
		if len(parts) < 4 {
			continue
		}

		typeChar := parts[0]
		sizeStr := parts[1]
		mtimeStr := parts[2]
		name := parts[3]

		// Skip . and ..
		if name == "." || name == ".." {
			continue
		}

		// Map find type character to our type string
		var entryType string
		switch typeChar {
		case "d":
			entryType = "dir"
		case "l":
			entryType = "symlink"
		default:
			entryType = "file"
		}

		// Parse size
		size, _ := strconv.ParseInt(sizeStr, 10, 64)

		// Parse mtime epoch (may have decimal like "1707926400.123456789")
		var modifiedAt string
		epochStr := mtimeStr
		if dotIdx := strings.Index(epochStr, "."); dotIdx != -1 {
			epochStr = epochStr[:dotIdx]
		}
		if epoch, err := strconv.ParseInt(epochStr, 10, 64); err == nil {
			modifiedAt = time.Unix(epoch, 0).UTC().Format(time.RFC3339)
		}

		entries = append(entries, FileEntry{
			Name:       name,
			Type:       entryType,
			Size:       size,
			ModifiedAt: modifiedAt,
		})
	}

	return entries
}
