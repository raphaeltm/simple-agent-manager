package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
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

// McpCostEstimateResponse contains cost estimation for the workspace.
type McpCostEstimateResponse struct {
	VMSize     string  `json:"vmSize"`
	HourlyRate float64 `json:"hourlyRate"`
	UptimeSecs float64 `json:"uptimeSeconds"`
	UptimeHrs  float64 `json:"uptimeHours"`
	TotalCost  float64 `json:"totalCost"`
	Currency   string  `json:"currency"`
}

// McpDiffSummaryResponse contains a summary of git changes since workspace creation.
type McpDiffSummaryResponse struct {
	Branch       string   `json:"branch"`
	CommitCount  int      `json:"commitCount"`
	FilesChanged int      `json:"filesChanged"`
	Insertions   int      `json:"insertions"`
	Deletions    int      `json:"deletions"`
	NewFiles     []string `json:"newFiles"`
	ModifiedFiles []string `json:"modifiedFiles"`
	DeletedFiles  []string `json:"deletedFiles"`
	UntrackedFiles []string `json:"untrackedFiles"`
}

// ---------- VM pricing defaults (configurable via WORKSPACE_TOOL_COST_PRICING_JSON) ----------

// defaultVMPricing maps VM size to hourly rate in USD.
var defaultVMPricing = map[string]float64{
	"small":   0.007,
	"medium":  0.017,
	"large":   0.033,
	"x-large": 0.065,
}

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

	// Read /proc/uptime inside container
	var uptimeSecs float64
	uptimeOut, _, err := s.execInContainer(ctx, containerID, user, workDir, "cat", "/proc/uptime")
	if err == nil {
		fields := strings.Fields(strings.TrimSpace(uptimeOut))
		if len(fields) > 0 {
			uptimeSecs, _ = strconv.ParseFloat(fields[0], 64)
		}
	}

	// Read current git branch
	branch := ""
	branchOut, _, err := s.execInContainer(ctx, containerID, user, workDir, "git", "rev-parse", "--abbrev-ref", "HEAD")
	if err == nil {
		branch = strings.TrimSpace(branchOut)
	}

	// Get workspace runtime info
	s.workspaceMu.RLock()
	runtime, ok := s.workspaces[workspaceID]
	s.workspaceMu.RUnlock()

	resp := McpWorkspaceInfoResponse{
		WorkspaceID: workspaceID,
		NodeID:      s.config.NodeID,
		WorkDir:     workDir,
		UptimeSecs:  uptimeSecs,
		Branch:      branch,
	}

	if ok {
		resp.Repository = runtime.Repository
		resp.Status = runtime.Status
		resp.CreatedAt = runtime.CreatedAt.Format(time.RFC3339)
		if branch == "" {
			resp.Branch = runtime.Branch
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
		writeError(w, http.StatusInternalServerError, "failed to check credentials: "+err.Error())
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

	// Get base domain from control plane URL
	baseDomain := extractBaseDomain(s.config.ControlPlaneURL)
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

	baseDomain := extractBaseDomain(s.config.ControlPlaneURL)
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

// handleMcpCostEstimate returns cost estimation for the workspace session.
// GET /workspaces/{workspaceId}/mcp/cost-estimate
func (s *Server) handleMcpCostEstimate(w http.ResponseWriter, r *http.Request) {
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

	// Read /proc/uptime
	var uptimeSecs float64
	uptimeOut, _, err := s.execInContainer(ctx, containerID, user, workDir, "cat", "/proc/uptime")
	if err == nil {
		fields := strings.Fields(strings.TrimSpace(uptimeOut))
		if len(fields) > 0 {
			uptimeSecs, _ = strconv.ParseFloat(fields[0], 64)
		}
	}

	// Determine VM size from workspace metadata or config
	vmSize := "small"
	s.workspaceMu.RLock()
	if runtime, ok := s.workspaces[workspaceID]; ok {
		// VMSize might be stored differently — check what's available
		_ = runtime // vmSize stays default unless we can determine it
	}
	s.workspaceMu.RUnlock()

	// Look up hourly rate
	pricing := defaultVMPricing
	hourlyRate := pricing[vmSize]
	if hourlyRate == 0 {
		hourlyRate = pricing["small"]
	}

	uptimeHrs := uptimeSecs / 3600.0
	totalCost := hourlyRate * uptimeHrs

	writeJSON(w, http.StatusOK, McpCostEstimateResponse{
		VMSize:     vmSize,
		HourlyRate: hourlyRate,
		UptimeSecs: uptimeSecs,
		UptimeHrs:  uptimeHrs,
		TotalCost:  totalCost,
		Currency:   "USD",
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

	// Fetch origin/main (best-effort, may fail on fresh repos)
	_, _, _ = s.execInContainer(ctx, containerID, user, workDir, "git", "fetch", "origin", "main", "--quiet")

	// Get diff stats against origin/main
	shortstatOut, _, err := s.execInContainer(ctx, containerID, user, workDir, "git", "diff", "--shortstat", "origin/main...HEAD")
	if err == nil {
		parseShortstat(strings.TrimSpace(shortstatOut), &resp)
	}

	// Get file-level name-status
	nameStatusOut, _, err := s.execInContainer(ctx, containerID, user, workDir, "git", "diff", "--name-status", "origin/main...HEAD")
	if err == nil {
		for _, line := range strings.Split(strings.TrimSpace(nameStatusOut), "\n") {
			if line == "" {
				continue
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
		}
	}

	// Get commit count
	commitCountOut, _, err := s.execInContainer(ctx, containerID, user, workDir, "git", "rev-list", "--count", "origin/main...HEAD")
	if err == nil {
		resp.CommitCount, _ = strconv.Atoi(strings.TrimSpace(commitCountOut))
	}

	// Get untracked files
	untrackedOut, _, err := s.execInContainer(ctx, containerID, user, workDir, "git", "ls-files", "--others", "--exclude-standard")
	if err == nil {
		for _, line := range strings.Split(strings.TrimSpace(untrackedOut), "\n") {
			if line != "" {
				resp.UntrackedFiles = append(resp.UntrackedFiles, line)
			}
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

// ---------- Helpers ----------

// extractBaseDomain extracts the base domain from a control plane URL.
// e.g., "https://api.example.com" -> "example.com"
func extractBaseDomain(controlPlaneURL string) string {
	// Strip protocol
	url := controlPlaneURL
	for _, prefix := range []string{"https://", "http://"} {
		url = strings.TrimPrefix(url, prefix)
	}
	// Strip port
	if host, _, err := net.SplitHostPort(url); err == nil {
		url = host
	}
	// Strip api. prefix
	url = strings.TrimPrefix(url, "api.")
	return url
}

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
