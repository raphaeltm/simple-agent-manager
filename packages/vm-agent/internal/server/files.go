package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
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
		log.Printf("[files] Error listing directory %q in workspace %s: %v", dirPath, workspaceID, err)
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
		log.Printf("[files] Error encoding response: %v", err)
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
		log.Printf("[files] Error finding files in workspace %s: %v", workspaceID, err)
		http.Error(w, `{"error":"failed to find files"}`, http.StatusInternalServerError)
		return
	}

	files := parseFileFindOutput(output)

	resp := FileFindResponse{Files: files}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		log.Printf("[files] Error encoding find response: %v", err)
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
