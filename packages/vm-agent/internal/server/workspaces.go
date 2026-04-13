package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os/exec"
	"strings"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/persistence"
)

func (s *Server) stopSessionHost(workspaceID, sessionID string) {
	hostKey := workspaceID + ":" + sessionID
	s.sessionHostMu.Lock()
	existing := s.sessionHosts[hostKey]
	if existing != nil {
		existing.Stop()
		delete(s.sessionHosts, hostKey)
	}
	delete(s.sessionMcpServers, hostKey)
	delete(s.sessionProfileOvr, hostKey)
	s.sessionHostMu.Unlock()

	// Clean up persisted MCP servers (best-effort).
	if s.store != nil {
		if err := s.store.DeleteSessionMcpServers(workspaceID, sessionID); err != nil {
			slog.Warn("Failed to delete MCP servers from SQLite",
				"workspace", workspaceID, "session", sessionID, "error", err)
		}
	}
}

// removeWorkspaceContainer stops and removes the Docker container associated with
// a workspace. This must be called before removing the workspace's Docker volume
// (Docker won't remove a volume that's in use by a container).
func (s *Server) removeWorkspaceContainer(workspaceID string) {
	runtime, ok := s.getWorkspaceRuntime(workspaceID)
	if !ok {
		return
	}

	labelValue := strings.TrimSpace(runtime.ContainerLabelValue)
	if labelValue == "" {
		return
	}

	filter := "label=" + s.config.ContainerLabelKey + "=" + labelValue
	ctx := context.Background()

	// Find all containers (running or stopped) matching the label.
	cmd := exec.CommandContext(ctx, "docker", "ps", "-aq", "--filter", filter)
	output, err := cmd.Output()
	if err != nil {
		slog.Warn("Failed to list containers for workspace", "workspace", workspaceID, "error", err)
		return
	}

	containers := strings.Fields(string(output))
	for _, id := range containers {
		slog.Info("Removing container", "containerId", id, "workspace", workspaceID)
		rmCmd := exec.CommandContext(ctx, "docker", "rm", "-f", id)
		if rmOutput, rmErr := rmCmd.CombinedOutput(); rmErr != nil {
			slog.Warn("Failed to remove container", "containerId", id, "error", rmErr, "output", strings.TrimSpace(string(rmOutput)))
		}
	}
}

func (s *Server) stopSessionHostsForWorkspace(workspaceID string) {
	prefix := workspaceID + ":"

	s.sessionHostMu.Lock()
	for key, host := range s.sessionHosts {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		host.Stop()
		delete(s.sessionHosts, key)
		delete(s.sessionMcpServers, key)
		delete(s.sessionProfileOvr, key)
	}
	s.sessionHostMu.Unlock()

	// Clean up all persisted MCP servers for this workspace (best-effort).
	if s.store != nil {
		if err := s.store.DeleteWorkspaceMcpServers(workspaceID); err != nil {
			slog.Warn("Failed to delete workspace MCP servers from SQLite",
				"workspace", workspaceID, "error", err)
		}
	}
}

func (s *Server) requireNodeManagementAuth(w http.ResponseWriter, r *http.Request, workspaceID string) bool {
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
		writeError(w, http.StatusUnauthorized, "missing Authorization header")
		return false
	}
	token := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
	if token == "" {
		writeError(w, http.StatusUnauthorized, "missing bearer token")
		return false
	}

	claims, err := s.jwtValidator.ValidateNodeManagementToken(token, workspaceID)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid management token")
		return false
	}

	routedNode := s.routedNodeID(r)
	if routedNode != "" && routedNode != s.config.NodeID {
		writeError(w, http.StatusForbidden, "node route mismatch")
		return false
	}

	if workspaceID != "" {
		routedWorkspace := s.routedWorkspaceID(r)
		if routedWorkspace == "" || routedWorkspace != workspaceID {
			writeError(w, http.StatusForbidden, "workspace route mismatch")
			return false
		}
		if claims.Workspace != workspaceID {
			writeError(w, http.StatusForbidden, "workspace claim mismatch")
			return false
		}
	}

	return true
}

func (s *Server) handleListWorkspaces(w http.ResponseWriter, r *http.Request) {
	if !s.requireNodeManagementAuth(w, r, "") {
		return
	}

	s.workspaceMu.RLock()
	defer s.workspaceMu.RUnlock()

	type workspaceSummary struct {
		ID         string `json:"id"`
		Repository string `json:"repository,omitempty"`
		Branch     string `json:"branch,omitempty"`
		Status     string `json:"status"`
		CreatedAt  string `json:"createdAt"`
		UpdatedAt  string `json:"updatedAt"`
		Sessions   int    `json:"sessions"`
	}

	result := make([]workspaceSummary, 0, len(s.workspaces))
	for _, runtime := range s.workspaces {
		result = append(result, workspaceSummary{
			ID:         runtime.ID,
			Repository: runtime.Repository,
			Branch:     runtime.Branch,
			Status:     runtime.Status,
			CreatedAt:  runtime.CreatedAt.Format(timeRFC3339),
			UpdatedAt:  runtime.UpdatedAt.Format(timeRFC3339),
			Sessions:   runtime.PTY.SessionCount(),
		})
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"workspaces": result})
}

const timeRFC3339 = "2006-01-02T15:04:05Z07:00"

func (s *Server) startWorkspaceProvision(
	runtime *WorkspaceRuntime,
	failureType string,
	failureMessage string,
	successType string,
	successMessage string,
	detail map[string]interface{},
) {
	go func() {
		recoveryMode, err := s.provisionWorkspaceRuntime(context.Background(), runtime)

		// Mark the boot log broadcaster as complete and schedule cleanup.
		// This notifies connected WebSocket clients that provisioning is done.
		if broadcaster := s.bootLogBroadcasters.Get(runtime.ID); broadcaster != nil {
			broadcaster.MarkComplete()
		}

		if err != nil {
			// Check if the workspace actually provisioned fine but only the
			// control-plane callback failed (transient network issue).
			var cbErr *bootstrap.CallbackError
			if errors.As(err, &cbErr) {
				// Workspace is functional — transition to the ready state and
				// mark the callback as pending so the heartbeat loop retries it.
				nextStatus := cbErr.Status
				if nextStatus == "" {
					nextStatus = "running"
				}
				s.casWorkspaceStatus(runtime.ID, []string{"creating"}, nextStatus)
				s.markReadyCallbackPending(runtime.ID, nextStatus)

				slog.Warn("Workspace ready but callback failed — will retry on next heartbeat",
					"workspace", runtime.ID,
					"status", nextStatus,
					"callbackError", cbErr.Err,
				)

				successDetail := make(map[string]interface{}, len(detail)+2)
				for key, value := range detail {
					successDetail[key] = value
				}
				successDetail["callbackPending"] = true
				if nextStatus == "recovery" {
					successDetail["recoveryMode"] = true
				}
				s.appendNodeEvent(runtime.ID, "warn", successType, successMessage+" (callback pending)", successDetail)

				// Start port scanner — workspace is functional
				s.StartPortScanner(runtime.ID)
				return
			}

			// Real provisioning failure.
			// CAS: only transition to error if still in "creating" state.
			// If the workspace was stopped/deleted while provisioning, skip.
			s.casWorkspaceStatus(runtime.ID, []string{"creating"}, "error")

			callbackToken := s.callbackTokenForWorkspace(runtime.ID)
			if callbackToken != "" {
				if callbackErr := s.notifyWorkspaceProvisioningFailed(context.Background(), runtime.ID, callbackToken, err.Error()); callbackErr != nil {
					slog.Error("Provisioning-failed callback error", "workspace", runtime.ID, "error", callbackErr)
				}
			}

			failureDetail := make(map[string]interface{}, len(detail)+1)
			for key, value := range detail {
				failureDetail[key] = value
			}
			failureDetail["error"] = err.Error()

			s.appendNodeEvent(runtime.ID, "error", failureType, failureMessage, failureDetail)
			return
		}

		nextStatus := "running"
		if recoveryMode {
			nextStatus = "recovery"
		}

		// CAS: only transition to a ready state if still in "creating" state.
		// Prevents overwriting "stopped" if user stopped workspace during provisioning.
		if !s.casWorkspaceStatus(runtime.ID, []string{"creating"}, nextStatus) {
			slog.Warn("Provisioning completed but status already changed from creating, skipping transition", "workspace", runtime.ID, "targetStatus", nextStatus)
			return
		}

		successDetail := make(map[string]interface{}, len(detail)+1)
		for key, value := range detail {
			successDetail[key] = value
		}
		if recoveryMode {
			successDetail["devcontainerFallback"] = true
			successDetail["recoveryMode"] = true
		}

		s.appendNodeEvent(runtime.ID, "info", successType, successMessage, successDetail)

		// Start port scanner for the newly provisioned workspace.
		// This is the dynamic-workspace counterpart to the boot-time scanner
		// started in OnBootstrapComplete (server.go).
		s.StartPortScanner(runtime.ID)
	}()
}

func (s *Server) handleCreateWorkspace(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceID            string `json:"workspaceId"`
		Repository             string `json:"repository"`
		Branch                 string `json:"branch"`
		CallbackToken          string `json:"callbackToken,omitempty"`
		GitUserName            string `json:"gitUserName,omitempty"`
		GitUserEmail           string `json:"gitUserEmail,omitempty"`
		GitHubID               string `json:"githubId,omitempty"`
		Lightweight            bool   `json:"lightweight,omitempty"`
		DevcontainerConfigName string `json:"devcontainerConfigName,omitempty"`
	}

	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if body.WorkspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	// Reject devcontainerConfigName values that could escape the .devcontainer/ directory.
	if name := body.DevcontainerConfigName; name != "" {
		if strings.Contains(name, "/") || strings.Contains(name, "\\") || strings.Contains(name, "..") {
			writeError(w, http.StatusBadRequest, "devcontainerConfigName must not contain path separators or '..'")
			return
		}
	}

	if !s.requireNodeManagementAuth(w, r, body.WorkspaceID) {
		return
	}

	branch := strings.TrimSpace(body.Branch)
	if branch == "" {
		branch = "main"
	}

	runtime := s.upsertWorkspaceRuntime(body.WorkspaceID, strings.TrimSpace(body.Repository), branch, "creating", strings.TrimSpace(body.CallbackToken), workspaceRuntimeOpts{
		GitUserName:            strings.TrimSpace(body.GitUserName),
		GitUserEmail:           strings.TrimSpace(body.GitUserEmail),
		GitHubID:               strings.TrimSpace(body.GitHubID),
		Lightweight:            body.Lightweight,
		DevcontainerConfigName: strings.TrimSpace(body.DevcontainerConfigName),
	})

	// Note: Per-workspace message reporter is created lazily in
	// handleStartAgentSession when the chatSessionID becomes available.
	// At workspace creation time, we only have workspaceID but not session context.
	// For boot-time reporters (auto-provisioned task nodes), the reporter was
	// already created with the correct workspaceID at server startup.

	s.appendNodeEvent(body.WorkspaceID, "info", "workspace.provisioning", "Workspace provisioning started", map[string]interface{}{
		"workspaceId": body.WorkspaceID,
		"repository":  body.Repository,
		"branch":      branch,
	})

	detail := map[string]interface{}{
		"workspaceId": body.WorkspaceID,
		"repository":  body.Repository,
		"branch":      branch,
	}
	s.startWorkspaceProvision(
		runtime,
		"workspace.provisioning_failed",
		"Workspace provisioning failed",
		"workspace.created",
		"Workspace runtime created",
		detail,
	)

	writeJSON(w, http.StatusAccepted, map[string]interface{}{
		"workspaceId": runtime.ID,
		"status":      "creating",
	})
}

func (s *Server) handleStopWorkspace(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return
	}

	runtime, ok := s.getWorkspaceRuntime(workspaceID)
	if !ok {
		writeError(w, http.StatusNotFound, "workspace not found")
		return
	}

	// CAS-style transition: only stop from valid states
	if !s.casWorkspaceStatus(workspaceID, []string{"running", "recovery", "creating", "error"}, "stopped") {
		writeJSON(w, http.StatusConflict, map[string]interface{}{
			"error":   "invalid_transition",
			"message": "Workspace cannot be stopped from current state: " + runtime.Status,
		})
		return
	}

	runtime.PTY.CloseAllSessions()

	sessions := s.agentSessions.List(workspaceID)
	for _, session := range sessions {
		_, _ = s.agentSessions.Stop(workspaceID, session.ID)
		s.stopSessionHost(workspaceID, session.ID)
	}

	// Stop browser sidecar if running — use background context so it isn't cancelled by client disconnect.
	s.stopBrowserSidecarWithTimeout(workspaceID, s.config.NekoBrowserStopTimeout)

	// Stop port scanner for this workspace.
	s.stopPortScanner(workspaceID)

	// Shut down per-workspace message reporter (final flush before cleanup).
	s.shutdownReporter(workspaceID)

	// Clear persisted tabs — workspace is stopped, no live sessions remain
	if s.store != nil {
		if err := s.store.DeleteWorkspaceTabs(workspaceID); err != nil {
			slog.Warn("Failed to delete persisted tabs on workspace stop", "workspace", workspaceID, "error", err)
		}
	}

	s.appendNodeEvent(workspaceID, "info", "workspace.stopped", "Workspace stopped", nil)
	writeJSON(w, http.StatusOK, map[string]interface{}{"status": "stopped"})
}

func (s *Server) handleRestartWorkspace(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return
	}

	runtime, ok := s.getWorkspaceRuntime(workspaceID)
	if !ok {
		writeError(w, http.StatusNotFound, "workspace not found")
		return
	}

	// CAS-style transition: only restart from stopped or error
	if !s.casWorkspaceStatus(workspaceID, []string{"stopped", "error"}, "creating") {
		writeJSON(w, http.StatusConflict, map[string]interface{}{
			"error":   "invalid_transition",
			"message": "Workspace cannot be restarted from current state: " + runtime.Status,
		})
		return
	}
	s.appendNodeEvent(workspaceID, "info", "workspace.restarting", "Workspace restart started", nil)

	s.startWorkspaceProvision(
		runtime,
		"workspace.restart_failed",
		"Workspace restart failed",
		"workspace.restarted",
		"Workspace restarted",
		map[string]interface{}{},
	)
	writeJSON(w, http.StatusAccepted, map[string]interface{}{"status": "creating"})
}

func (s *Server) handleRebuildWorkspace(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return
	}

	runtime, ok := s.getWorkspaceRuntime(workspaceID)
	if !ok {
		writeError(w, http.StatusNotFound, "workspace not found")
		return
	}

	// CAS-style transition: only rebuild from running/recovery/error
	if !s.casWorkspaceStatus(workspaceID, []string{"running", "recovery", "error"}, "creating") {
		writeJSON(w, http.StatusConflict, map[string]interface{}{
			"error":   "invalid_transition",
			"message": "Workspace must be running, recovery, or in error state to rebuild, currently " + runtime.Status,
		})
		return
	}
	s.appendNodeEvent(workspaceID, "info", "workspace.rebuilding", "Rebuilding devcontainer", nil)

	s.startWorkspaceProvision(
		runtime,
		"workspace.rebuild_failed",
		"Workspace rebuild failed",
		"workspace.rebuilt",
		"Workspace rebuilt with devcontainer",
		map[string]interface{}{},
	)

	writeJSON(w, http.StatusAccepted, map[string]interface{}{"status": "rebuilding"})
}

func (s *Server) handleDeleteWorkspace(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return
	}

	s.stopSessionHostsForWorkspace(workspaceID)

	// Stop browser sidecar if running — use background context so it isn't cancelled by client disconnect.
	s.stopBrowserSidecarWithTimeout(workspaceID, s.config.NekoBrowserStopTimeout)

	// Stop port scanner for this workspace.
	s.stopPortScanner(workspaceID)

	// Shut down per-workspace message reporter (final flush before cleanup).
	s.shutdownReporter(workspaceID)

	// Remove the devcontainer and its Docker volume.
	// The container must be removed before the volume (Docker won't remove a volume in use).
	s.removeWorkspaceContainer(workspaceID)
	bootstrap.RemoveCredentialHelperFromHost(workspaceID)
	if err := bootstrap.RemoveVolume(context.Background(), workspaceID); err != nil {
		slog.Warn("Failed to remove Docker volume for workspace", "workspace", workspaceID, "error", err)
	}

	s.removeWorkspaceRuntime(workspaceID)

	// Remove all persisted tabs and MCP server configs for this workspace
	if s.store != nil {
		if err := s.store.DeleteWorkspaceTabs(workspaceID); err != nil {
			slog.Warn("Failed to delete persisted tabs for workspace", "workspace", workspaceID, "error", err)
		}
		if err := s.store.DeleteWorkspaceMcpServers(workspaceID); err != nil {
			slog.Warn("Failed to delete persisted MCP servers for workspace", "workspace", workspaceID, "error", err)
		}
	}

	s.appendNodeEvent(workspaceID, "info", "workspace.deleted", "Workspace deleted", nil)
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

func (s *Server) handleListTabs(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	// Accept both workspace session cookies (browser) and management tokens (control plane).
	// Also accept workspace JWT token via ?token= query param for first-load scenarios
	// before a session cookie has been established.
	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		if !s.requireNodeManagementAuth(w, r, workspaceID) {
			return
		}
	}

	if s.store == nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{"tabs": []interface{}{}})
		return
	}

	tabs, err := s.store.ListTabs(workspaceID)
	if err != nil {
		slog.Error("Error listing tabs for workspace", "workspace", workspaceID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to list tabs")
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"tabs": tabs})
}

// enrichedSession extends agentsessions.Session with live SessionHost state.
type enrichedSession struct {
	agentsessions.Session
	HostStatus  *string `json:"hostStatus,omitempty"`
	ViewerCount *int    `json:"viewerCount,omitempty"`
}

func (s *Server) handleListAgentSessions(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}
	// Accept both workspace session cookies (browser) and management tokens (control plane).
	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		if !s.requireNodeManagementAuth(w, r, workspaceID) {
			return
		}
	}

	sessions := s.agentSessions.List(workspaceID)
	enriched := make([]enrichedSession, len(sessions))

	for i, session := range sessions {
		enriched[i] = enrichedSession{Session: session}

		hostKey := workspaceID + ":" + session.ID
		s.sessionHostMu.Lock()
		host := s.sessionHosts[hostKey]
		s.sessionHostMu.Unlock()

		if host != nil {
			status := string(host.Status())
			viewers := host.ViewerCount()
			enriched[i].HostStatus = &status
			enriched[i].ViewerCount = &viewers
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"sessions": enriched,
	})
}

func (s *Server) handleCreateAgentSession(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}
	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return
	}

	var body struct {
		SessionID     string `json:"sessionId"`
		Label         string `json:"label"`
		ChatSessionID string `json:"chatSessionId"` // Chat session ID for message routing (warm node reuse)
		ProjectID     string `json:"projectId"`      // Project ID for late-init of message reporter (manual nodes)
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(body.SessionID) == "" {
		writeError(w, http.StatusBadRequest, "sessionId is required")
		return
	}

	chatSID := strings.TrimSpace(body.ChatSessionID)
	projectID := strings.TrimSpace(body.ProjectID)

	// Store projectID on workspace runtime for ACP heartbeat goroutine.
	if projectID != "" {
		s.workspaceMu.Lock()
		if rt, ok := s.workspaces[workspaceID]; ok {
			rt.ProjectID = projectID
		}
		s.workspaceMu.Unlock()
	}

	// Ensure a per-workspace message reporter exists for this workspace.
	// This handles both:
	// - Auto-provisioned nodes: reporter may already exist from boot time
	// - Manually provisioned nodes: reporter created here on first agent session
	// - Warm node reuse: reporter already exists but session ID needs updating
	if chatSID != "" && projectID != "" {
		r := s.getOrCreateReporter(workspaceID, projectID, chatSID)
		if r != nil {
			// Always update session ID: handles warm-node reuse where the workspace
			// is reused for a new task with a different chatSessionID. SetSessionID
			// clears stale outbox messages from the previous session.
			r.SetSessionID(chatSID)
		}
	}

	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	session, idempotentHit, err := s.agentSessions.Create(workspaceID, strings.TrimSpace(body.SessionID), strings.TrimSpace(body.Label), idempotencyKey)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if !idempotentHit {
		s.appendNodeEvent(workspaceID, "info", "agent_session.created", "Agent session created", map[string]interface{}{"sessionId": session.ID})

		// Persist chat tab for cross-device continuity
		if s.store != nil {
			tabCount, _ := s.store.TabCount(workspaceID)
			if err := s.store.InsertTab(persistence.Tab{
				ID:          session.ID,
				WorkspaceID: workspaceID,
				Type:        "chat",
				Label:       session.Label,
				AgentID:     "", // Agent ID is inferred from label currently
				SortOrder:   tabCount,
			}); err != nil {
				slog.Warn("Failed to persist chat tab", "error", err)
			}
		}
	}

	writeJSON(w, http.StatusCreated, session)
}

// handleStartAgentSession starts an agent process and sends an initial prompt
// for a previously created agent session. This is the missing link for task-driven
// workspaces: the control plane creates the session (handleCreateAgentSession),
// then starts the agent with the task description as the initial prompt.
//
// The agent starts and runs headlessly — no browser WebSocket is required.
// When a browser connects later, it receives full message replay.
// The OnPromptComplete callback handles git push and task status updates.
func (s *Server) handleStartAgentSession(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	sessionID := r.PathValue("sessionId")
	if workspaceID == "" || sessionID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId and sessionId are required")
		return
	}
	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return
	}

	var body struct {
		AgentType        string               `json:"agentType"`
		InitialPrompt    string               `json:"initialPrompt"`
		McpServers       []acp.McpServerEntry  `json:"mcpServers,omitempty"`
		Model            string               `json:"model,omitempty"`
		PermissionMode   string               `json:"permissionMode,omitempty"`
		OpencodeProvider string               `json:"opencodeProvider,omitempty"`
		OpencodeBaseUrl  string               `json:"opencodeBaseUrl,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(body.AgentType) == "" {
		writeError(w, http.StatusBadRequest, "agentType is required")
		return
	}
	if strings.TrimSpace(body.InitialPrompt) == "" {
		writeError(w, http.StatusBadRequest, "initialPrompt is required")
		return
	}

	session, exists := s.agentSessions.Get(workspaceID, sessionID)
	if !exists {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	if session.Status != agentsessions.StatusRunning {
		writeError(w, http.StatusConflict, "session is not running")
		return
	}

	runtime, ok := s.getWorkspaceRuntime(workspaceID)
	if !ok {
		writeError(w, http.StatusNotFound, "workspace not found")
		return
	}

	// Validate and store MCP servers for this session before creating the SessionHost.
	// getOrCreateSessionHost reads these and wires them into GatewayConfig.
	hostKey := workspaceID + ":" + sessionID
	for i, srv := range body.McpServers {
		u := strings.TrimSpace(srv.URL)
		if u == "" {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("mcpServers[%d].url is required", i))
			return
		}
		if !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("mcpServers[%d].url must be an HTTP(S) URL", i))
			return
		}
		body.McpServers[i].URL = u
	}
	if len(body.McpServers) > 0 {
		s.sessionHostMu.Lock()
		s.sessionMcpServers[hostKey] = body.McpServers
		s.sessionHostMu.Unlock()

		// Persist to SQLite so MCP servers survive VM agent restarts and
		// are available even if a WebSocket creates the SessionHost first.
		if s.store != nil {
			persistEntries := make([]persistence.McpServer, len(body.McpServers))
			for i, srv := range body.McpServers {
				persistEntries[i] = persistence.McpServer{URL: srv.URL, Token: srv.Token}
			}
			if err := s.store.UpsertSessionMcpServers(workspaceID, sessionID, persistEntries); err != nil {
				slog.Warn("Failed to persist MCP servers to SQLite",
					"workspace", workspaceID, "session", sessionID, "error", err)
			}
		}

		slog.Info("MCP servers registered for agent session",
			"workspace", workspaceID, "session", sessionID, "count", len(body.McpServers))
	}

	// Always store profile overrides so getOrCreateSessionHost can apply them.
	// Even empty overrides are stored to distinguish "no profile" from "not set".
	s.sessionHostMu.Lock()
	s.sessionProfileOvr[hostKey] = profileOverrides{
		Model:            body.Model,
		PermissionMode:   body.PermissionMode,
		OpencodeProvider: body.OpencodeProvider,
		OpencodeBaseUrl:  body.OpencodeBaseUrl,
	}
	s.sessionHostMu.Unlock()
	if body.Model != "" || body.PermissionMode != "" || body.OpencodeProvider != "" {
		slog.Info("Profile overrides registered for agent session",
			"workspace", workspaceID, "session", sessionID,
			"model", body.Model, "permissionMode", body.PermissionMode,
			"opencodeProvider", body.OpencodeProvider)
	}

	// Create or retrieve the SessionHost for this session.
	host := s.getOrCreateSessionHost(hostKey, workspaceID, sessionID, session, runtime, "")

	s.appendNodeEvent(workspaceID, "info", "agent_session.starting", "Starting agent with initial prompt", map[string]interface{}{
		"sessionId": sessionID,
		"agentType": body.AgentType,
	})

	// Start agent and send initial prompt in a background goroutine.
	// The endpoint returns 202 immediately — the agent runs asynchronously.
	go s.startAgentWithPrompt(host, workspaceID, sessionID, body.AgentType, body.InitialPrompt)

	writeJSON(w, http.StatusAccepted, map[string]interface{}{
		"status":    "starting",
		"sessionId": sessionID,
	})
}

// startAgentWithPrompt runs SelectAgent and then sends the initial prompt.
// Called as a goroutine from handleStartAgentSession.
func (s *Server) startAgentWithPrompt(host *acp.SessionHost, workspaceID, sessionID, agentType, initialPrompt string) {
	ctx := context.Background()

	// Idempotency: if the host is already prompting, a prompt is in progress —
	// do not send a duplicate. If already ready, skip agent selection.
	currentStatus := host.Status()
	if currentStatus == acp.HostPrompting {
		slog.Info("Agent already processing a prompt, skipping duplicate",
			"workspace", workspaceID, "session", sessionID)
		return
	}
	if currentStatus == acp.HostReady {
		slog.Info("Agent already running, skipping SelectAgent",
			"workspace", workspaceID, "session", sessionID)
	} else {
		host.SelectAgent(ctx, agentType)

		if host.Status() != acp.HostReady {
			errMsg := "Agent failed to start for task-driven session"
			slog.Error(errMsg, "workspace", workspaceID, "session", sessionID, "status", string(host.Status()))
			s.appendNodeEvent(workspaceID, "error", "agent_session.start_failed", errMsg, map[string]interface{}{
				"sessionId": sessionID,
				"agentType": agentType,
			})

			// Fire the completion callback with error so the control plane
			// can transition the task to failed.
			if cb := host.OnPromptCompleteCallback(); cb != nil {
				cb("error", fmt.Errorf("%s: agent status is %s", errMsg, host.Status()))
			}
			return
		}
	}

	slog.Info("Agent ready, sending initial prompt",
		"workspace", workspaceID, "session", sessionID, "agentType", agentType)
	s.appendNodeEvent(workspaceID, "info", "agent_session.prompt_sent", "Sending initial task prompt to agent", map[string]interface{}{
		"sessionId": sessionID,
		"agentType": agentType,
	})

	// Build JSON-RPC params matching what HandlePrompt expects.
	promptParams, _ := json.Marshal(map[string]interface{}{
		"prompt": []map[string]string{
			{"type": "text", "text": initialPrompt},
		},
	})
	syntheticReqID, _ := json.Marshal("server-initiated-1")

	// HandlePrompt blocks until the agent completes. The OnPromptComplete
	// callback fires automatically, handling git push and task status updates.
	host.HandlePrompt(ctx, syntheticReqID, promptParams, "server")
}

// handleSendPrompt sends a follow-up prompt to a running agent session.
// Called by the control plane when a user sends a follow-up message in the chat UI.
// The prompt is dispatched asynchronously — the endpoint returns 202 immediately
// and responses flow back through the message reporter.
func (s *Server) handleSendPrompt(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	sessionID := r.PathValue("sessionId")
	if workspaceID == "" || sessionID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId and sessionId are required")
		return
	}
	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return
	}

	var body struct {
		Prompt string `json:"prompt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(body.Prompt) == "" {
		writeError(w, http.StatusBadRequest, "prompt is required")
		return
	}

	// Look up the existing SessionHost for this session.
	hostKey := workspaceID + ":" + sessionID
	s.sessionHostMu.Lock()
	host := s.sessionHosts[hostKey]
	s.sessionHostMu.Unlock()

	if host == nil {
		writeError(w, http.StatusNotFound, "no active agent session found")
		return
	}

	// Check agent status — must be ready (not already prompting).
	status := host.Status()
	if status == acp.HostPrompting {
		writeJSON(w, http.StatusConflict, map[string]interface{}{
			"status":  "busy",
			"message": "Agent is already processing a prompt",
		})
		return
	}
	if status != acp.HostReady {
		writeJSON(w, http.StatusConflict, map[string]interface{}{
			"status":  string(status),
			"message": "Agent is not ready for prompts",
		})
		return
	}

	// Build JSON-RPC params matching what HandlePrompt expects.
	promptParams, _ := json.Marshal(map[string]interface{}{
		"prompt": []map[string]string{
			{"type": "text", "text": strings.TrimSpace(body.Prompt)},
		},
	})
	syntheticReqID, _ := json.Marshal("control-plane-followup")

	s.appendNodeEvent(workspaceID, "info", "agent_session.followup_prompt", "Sending follow-up prompt to agent", map[string]interface{}{
		"sessionId": sessionID,
	})

	// Dispatch asynchronously — HandlePrompt blocks until the agent completes.
	go host.HandlePrompt(context.Background(), syntheticReqID, promptParams, "control-plane")

	writeJSON(w, http.StatusAccepted, map[string]interface{}{
		"status":    "prompting",
		"sessionId": sessionID,
	})
}

func (s *Server) handleCancelAgentSession(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	sessionID := r.PathValue("sessionId")
	if workspaceID == "" || sessionID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId and sessionId are required")
		return
	}
	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return
	}

	// Look up the existing SessionHost for this session.
	hostKey := workspaceID + ":" + sessionID
	s.sessionHostMu.Lock()
	host := s.sessionHosts[hostKey]
	s.sessionHostMu.Unlock()

	if host == nil {
		writeError(w, http.StatusNotFound, "no active agent session found")
		return
	}

	// Only cancel if a prompt is actually in flight.
	if !host.IsPrompting() {
		writeJSON(w, http.StatusConflict, map[string]interface{}{
			"status":  "idle",
			"message": "No prompt in flight to cancel",
		})
		return
	}

	host.CancelPrompt()

	slog.Info("Agent session prompt cancelled via HTTP", "workspace", workspaceID, "session", sessionID)
	s.appendNodeEvent(workspaceID, "info", "agent_session.prompt_cancelled", "Agent prompt cancelled via HTTP", map[string]interface{}{
		"sessionId": sessionID,
	})

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":  "cancelled",
		"message": "Prompt cancel signal sent",
	})
}

func (s *Server) handleStopAgentSession(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	sessionID := r.PathValue("sessionId")
	if workspaceID == "" || sessionID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId and sessionId are required")
		return
	}
	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return
	}

	session, err := s.agentSessions.Stop(workspaceID, sessionID)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}

	s.stopSessionHost(workspaceID, sessionID)

	// Remove persisted chat tab
	if s.store != nil {
		if err := s.store.DeleteTab(sessionID); err != nil {
			slog.Warn("Failed to delete persisted chat tab", "error", err)
		}
	}

	s.appendNodeEvent(workspaceID, "info", "agent_session.stopped", "Agent session stopped", map[string]interface{}{"sessionId": sessionID})
	writeJSON(w, http.StatusOK, session)
}

// suspendSessionHost suspends a SessionHost: stops the agent process but
// preserves the AcpSessionID for later resumption via LoadSession.
func (s *Server) suspendSessionHost(workspaceID, sessionID string) (acpSessionID string, agentType string) {
	hostKey := workspaceID + ":" + sessionID
	s.sessionHostMu.Lock()
	existing := s.sessionHosts[hostKey]
	if existing != nil {
		acpSessionID, agentType = existing.Suspend()
		delete(s.sessionHosts, hostKey)
	}
	s.sessionHostMu.Unlock()
	return acpSessionID, agentType
}

// handleAutoSuspend is called by the SessionHost's OnSuspend callback when
// auto-suspend fires. It removes the SessionHost from the map (the host has
// already stopped itself) and transitions the session to suspended status.
func (s *Server) handleAutoSuspend(workspaceID, sessionID string) {
	// Remove the SessionHost and its in-memory MCP config from the map (the host
	// has already stopped). MCP servers are intentionally NOT deleted from SQLite
	// so they can be recovered when the session resumes via getOrCreateSessionHost.
	hostKey := workspaceID + ":" + sessionID
	s.sessionHostMu.Lock()
	delete(s.sessionHosts, hostKey)
	delete(s.sessionMcpServers, hostKey)
	// Note: sessionProfileOvr is intentionally NOT deleted on suspend so that
	// overrides survive suspend/resume cycles (same rationale as MCP servers
	// in SQLite — profile overrides are re-read from the in-memory map when
	// getOrCreateSessionHost rebuilds the SessionHost on resume).
	s.sessionHostMu.Unlock()

	// Transition the in-memory session to suspended.
	session, err := s.agentSessions.Suspend(workspaceID, sessionID)
	if err != nil {
		slog.Warn("Auto-suspend: failed to transition session", "workspace", workspaceID, "session", sessionID, "error", err)
		return
	}

	slog.Info("Auto-suspend: session suspended", "workspace", workspaceID, "session", sessionID, "acpSessionId", session.AcpSessionID)
}

func (s *Server) handleSuspendAgentSession(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	sessionID := r.PathValue("sessionId")
	if workspaceID == "" || sessionID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId and sessionId are required")
		return
	}
	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return
	}

	// Suspend the SessionHost first (stops agent process, preserves AcpSessionID).
	acpSessionID, agentType := s.suspendSessionHost(workspaceID, sessionID)

	// Transition the in-memory session to suspended.
	session, err := s.agentSessions.Suspend(workspaceID, sessionID)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}

	// Preserve AcpSessionID if the SessionHost provided one that the session
	// doesn't already have (e.g. was set during this agent's lifecycle).
	if acpSessionID != "" && session.AcpSessionID == "" {
		_ = s.agentSessions.UpdateAcpSessionID(workspaceID, sessionID, acpSessionID, agentType)
		session.AcpSessionID = acpSessionID
		session.AgentType = agentType
	}

	s.appendNodeEvent(workspaceID, "info", "agent_session.suspended", "Agent session suspended", map[string]interface{}{
		"sessionId":    sessionID,
		"acpSessionId": session.AcpSessionID,
		"agentType":    session.AgentType,
	})

	writeJSON(w, http.StatusOK, session)
}

func (s *Server) handleResumeAgentSession(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	sessionID := r.PathValue("sessionId")
	if workspaceID == "" || sessionID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId and sessionId are required")
		return
	}
	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return
	}

	// Transition the in-memory session back to running.
	session, err := s.agentSessions.Resume(workspaceID, sessionID)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}

	// Note: we do NOT create a SessionHost here. The SessionHost will be
	// created on-demand when a viewer connects via WebSocket (handleAgentWS).
	// The hydrated AcpSessionID in the session record will trigger LoadSession
	// when the SessionHost starts its agent.

	s.appendNodeEvent(workspaceID, "info", "agent_session.resumed", "Agent session resumed", map[string]interface{}{
		"sessionId":    sessionID,
		"acpSessionId": session.AcpSessionID,
		"agentType":    session.AgentType,
	})

	writeJSON(w, http.StatusOK, session)
}
