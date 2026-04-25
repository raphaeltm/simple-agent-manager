package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

// ---------- Response types ----------

// McpWorkspaceInfoResponse contains workspace metadata for agent orientation.
type McpWorkspaceInfoResponse struct {
	WorkspaceID string  `json:"workspaceId"`
	NodeID      string  `json:"nodeId"`
	Repository  string  `json:"repository"`
	Branch      string  `json:"branch"`
	Status      string  `json:"status"`
	WorkDir     string  `json:"workDir"`
	UptimeSecs  float64 `json:"uptimeSeconds"`
	CreatedAt   string  `json:"createdAt"`
}

// McpCredentialStatusResponse reports which credentials are available inside the container.
type McpCredentialStatusResponse struct {
	Credentials []McpCredentialEntry `json:"credentials"`
}

// McpCredentialEntry represents a single credential's status.
type McpCredentialEntry struct {
	Name      string `json:"name"`
	Available bool   `json:"available"`
	Hint      string `json:"hint,omitempty"`
}

// McpNetworkInfoResponse contains network info and detected ports.
type McpNetworkInfoResponse struct {
	WorkspaceURL string         `json:"workspaceUrl"`
	BaseDomain   string         `json:"baseDomain"`
	Ports        []McpPortEntry `json:"ports"`
}

// McpPortEntry describes a single detected port.
type McpPortEntry struct {
	Port        int    `json:"port"`
	ExternalURL string `json:"externalUrl"`
}

// McpExposePortRequest is the body for the expose-port endpoint.
type McpExposePortRequest struct {
	Port  int    `json:"port"`
	Label string `json:"label,omitempty"`
}

// McpExposePortResponse contains the external URL for an exposed port.
type McpExposePortResponse struct {
	Port        int    `json:"port"`
	ExternalURL string `json:"externalUrl"`
	Listening   bool   `json:"listening"`
	Label       string `json:"label,omitempty"`
}

// McpDiffSummaryResponse contains a summary of git changes since workspace creation.
type McpDiffSummaryResponse struct {
	Branch         string   `json:"branch"`
	CommitCount    int      `json:"commitCount"`
	FilesChanged   int      `json:"filesChanged"`
	Insertions     int      `json:"insertions"`
	Deletions      int      `json:"deletions"`
	NewFiles       []string `json:"newFiles"`
	ModifiedFiles  []string `json:"modifiedFiles"`
	DeletedFiles   []string `json:"deletedFiles"`
	UntrackedFiles []string `json:"untrackedFiles"`
	Truncated      bool     `json:"truncated,omitempty"`
}

// maxFileListEntries caps file lists in diff summary responses to prevent unbounded output.
const maxFileListEntries = 500

// ---------- Handlers ----------

// handleMcpWorkspaceInfo returns workspace metadata for agent orientation.
// GET /workspaces/{workspaceId}/mcp/workspace-info
func (s *Server) handleMcpWorkspaceInfo(w http.ResponseWriter, r *http.Request) {
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

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	// Read current git branch
	branch := ""
	branchOut, _, err := s.execInContainer(ctx, containerID, user, workDir, "git", "rev-parse", "--abbrev-ref", "HEAD")
	if err == nil {
		branch = strings.TrimSpace(branchOut)
	}

	// Get workspace runtime info (single read under lock)
	s.workspaceMu.RLock()
	runtime, ok := s.workspaces[workspaceID]
	var runtimeCopy WorkspaceRuntime
	if ok {
		runtimeCopy = *runtime
	}
	s.workspaceMu.RUnlock()

	resp := McpWorkspaceInfoResponse{
		WorkspaceID: workspaceID,
		NodeID:      s.config.NodeID,
		WorkDir:     workDir,
		Branch:      branch,
	}

	if ok {
		resp.Repository = runtimeCopy.Repository
		resp.Status = runtimeCopy.Status
		resp.CreatedAt = runtimeCopy.CreatedAt.Format(time.RFC3339)
		resp.UptimeSecs = time.Since(runtimeCopy.CreatedAt).Seconds()
		if branch == "" {
			resp.Branch = runtimeCopy.Branch
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

// handleMcpCredentialStatus checks which credentials are available inside the container.
// GET /workspaces/{workspaceId}/mcp/credential-status
func (s *Server) handleMcpCredentialStatus(w http.ResponseWriter, r *http.Request) {
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

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	// Get all env vars from container (never return values, only check presence)
	envOut, _, err := s.execInContainer(ctx, containerID, user, workDir, "printenv")
	if err != nil {
		slog.Error("credential-status: printenv failed",
			"workspaceID", workspaceID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to check credentials")
		return
	}

	envVars := make(map[string]bool)
	for _, line := range strings.Split(envOut, "\n") {
		if idx := strings.IndexByte(line, '='); idx > 0 {
			envVars[line[:idx]] = true
		}
	}

	credentials := []McpCredentialEntry{
		{Name: "GH_TOKEN", Available: envVars["GH_TOKEN"], Hint: "GitHub personal access token"},
		{Name: "ANTHROPIC_API_KEY", Available: envVars["ANTHROPIC_API_KEY"], Hint: "Anthropic API key"},
		{Name: "CLAUDE_CODE_OAUTH_TOKEN", Available: envVars["CLAUDE_CODE_OAUTH_TOKEN"], Hint: "Claude Code OAuth token"},
		{Name: "SAM_MCP_TOKEN", Available: envVars["SAM_MCP_TOKEN"], Hint: "SAM MCP token for control plane access"},
	}

	writeJSON(w, http.StatusOK, McpCredentialStatusResponse{Credentials: credentials})
}

// handleMcpNetworkInfo returns workspace network info and detected ports.
// GET /workspaces/{workspaceId}/mcp/network-info
func (s *Server) handleMcpNetworkInfo(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	baseDomain := config.DeriveBaseDomain(s.config.ControlPlaneURL)
	workspaceURL := fmt.Sprintf("https://ws-%s.%s", workspaceID, baseDomain)

	// Get detected ports from port scanner
	s.portScannerMu.RLock()
	scanner := s.portScanners[workspaceID]
	s.portScannerMu.RUnlock()

	var ports []McpPortEntry
	if scanner != nil {
		for _, p := range scanner.Ports() {
			ports = append(ports, McpPortEntry{
				Port:        p.Port,
				ExternalURL: fmt.Sprintf("https://ws-%s--%d.%s", workspaceID, p.Port, baseDomain),
			})
		}
	}
	if ports == nil {
		ports = []McpPortEntry{}
	}

	writeJSON(w, http.StatusOK, McpNetworkInfoResponse{
		WorkspaceURL: workspaceURL,
		BaseDomain:   baseDomain,
		Ports:        ports,
	})
}

// handleMcpExposePort validates a port is listening and returns its external URL.
// POST /workspaces/{workspaceId}/mcp/expose-port
func (s *Server) handleMcpExposePort(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	var req McpExposePortRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	if req.Port < 1 || req.Port > 65535 {
		writeError(w, http.StatusBadRequest, "port must be between 1 and 65535")
		return
	}

	baseDomain := config.DeriveBaseDomain(s.config.ControlPlaneURL)
	externalURL := fmt.Sprintf("https://ws-%s--%d.%s", workspaceID, req.Port, baseDomain)

	// Check if port is actually listening via port scanner
	listening := false
	s.portScannerMu.RLock()
	scanner := s.portScanners[workspaceID]
	s.portScannerMu.RUnlock()
	if scanner != nil {
		for _, p := range scanner.Ports() {
			if p.Port == req.Port {
				listening = true
				break
			}
		}
	}

	writeJSON(w, http.StatusOK, McpExposePortResponse{
		Port:        req.Port,
		ExternalURL: externalURL,
		Listening:   listening,
		Label:       req.Label,
	})
}

// handleMcpDiffSummary returns a summary of all changes since workspace creation.
// GET /workspaces/{workspaceId}/mcp/diff-summary
func (s *Server) handleMcpDiffSummary(w http.ResponseWriter, r *http.Request) {
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

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	resp := McpDiffSummaryResponse{
		NewFiles:       []string{},
		ModifiedFiles:  []string{},
		DeletedFiles:   []string{},
		UntrackedFiles: []string{},
	}

	// Get current branch
	branchOut, _, err := s.execInContainer(ctx, containerID, user, workDir, "git", "rev-parse", "--abbrev-ref", "HEAD")
	if err == nil {
		resp.Branch = strings.TrimSpace(branchOut)
	}

	// Determine the default remote branch (try origin/main, fall back to origin/master)
	baseBranch := "origin/main"
	_, _, err = s.execInContainer(ctx, containerID, user, workDir, "git", "fetch", "origin", "main", "--quiet")
	if err != nil {
		// main doesn't exist — try master
		_, _, err = s.execInContainer(ctx, containerID, user, workDir, "git", "fetch", "origin", "master", "--quiet")
		if err == nil {
			baseBranch = "origin/master"
		}
	}

	// Get diff stats against base branch
	shortstatOut, _, err := s.execInContainer(ctx, containerID, user, workDir, "git", "diff", "--shortstat", baseBranch+"...HEAD")
	if err == nil {
		parseShortstat(strings.TrimSpace(shortstatOut), &resp)
	}

	// Get file-level name-status (capped)
	nameStatusOut, _, err := s.execInContainer(ctx, containerID, user, workDir, "git", "diff", "--name-status", baseBranch+"...HEAD")
	if err == nil {
		totalFiles := 0
		for _, line := range strings.Split(strings.TrimSpace(nameStatusOut), "\n") {
			if line == "" {
				continue
			}
			if totalFiles >= maxFileListEntries {
				resp.Truncated = true
				break
			}
			parts := strings.SplitN(line, "\t", 2)
			if len(parts) < 2 {
				continue
			}
			status := parts[0]
			file := parts[1]
			switch {
			case strings.HasPrefix(status, "A"):
				resp.NewFiles = append(resp.NewFiles, file)
			case strings.HasPrefix(status, "M"):
				resp.ModifiedFiles = append(resp.ModifiedFiles, file)
			case strings.HasPrefix(status, "D"):
				resp.DeletedFiles = append(resp.DeletedFiles, file)
			}
			totalFiles++
		}
	}

	// Get commit count
	commitCountOut, _, err := s.execInContainer(ctx, containerID, user, workDir, "git", "rev-list", "--count", baseBranch+"...HEAD")
	if err == nil {
		resp.CommitCount, _ = strconv.Atoi(strings.TrimSpace(commitCountOut))
	}

	// Get untracked files (capped)
	untrackedOut, _, err := s.execInContainer(ctx, containerID, user, workDir, "git", "ls-files", "--others", "--exclude-standard")
	if err == nil {
		count := 0
		for _, line := range strings.Split(strings.TrimSpace(untrackedOut), "\n") {
			if line != "" {
				if count >= maxFileListEntries {
					resp.Truncated = true
					break
				}
				resp.UntrackedFiles = append(resp.UntrackedFiles, line)
				count++
			}
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

// ---------- Helpers ----------

// parseShortstat parses the output of git diff --shortstat.
// Example: " 3 files changed, 10 insertions(+), 5 deletions(-)"
func parseShortstat(line string, resp *McpDiffSummaryResponse) {
	parts := strings.Split(line, ",")
	for _, part := range parts {
		part = strings.TrimSpace(part)
		fields := strings.Fields(part)
		if len(fields) < 2 {
			continue
		}
		n, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		switch {
		case strings.Contains(part, "file"):
			resp.FilesChanged = n
		case strings.Contains(part, "insertion"):
			resp.Insertions = n
		case strings.Contains(part, "deletion"):
			resp.Deletions = n
		}
	}
}
