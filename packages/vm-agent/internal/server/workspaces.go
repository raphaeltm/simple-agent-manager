package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os/exec"
	"strings"

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
	s.sessionHostMu.Unlock()
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
		log.Printf("Warning: failed to list containers for workspace %s: %v", workspaceID, err)
		return
	}

	containers := strings.Fields(string(output))
	for _, id := range containers {
		log.Printf("Removing container %s for workspace %s", id, workspaceID)
		rmCmd := exec.CommandContext(ctx, "docker", "rm", "-f", id)
		if rmOutput, rmErr := rmCmd.CombinedOutput(); rmErr != nil {
			log.Printf("Warning: failed to remove container %s: %v: %s", id, rmErr, strings.TrimSpace(string(rmOutput)))
		}
	}
}

func (s *Server) stopSessionHostsForWorkspace(workspaceID string) {
	prefix := workspaceID + ":"

	s.sessionHostMu.Lock()
	defer s.sessionHostMu.Unlock()

	for key, host := range s.sessionHosts {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		host.Stop()
		delete(s.sessionHosts, key)
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
		if claims.Workspace != "" && claims.Workspace != workspaceID {
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
		usedFallback, err := s.provisionWorkspaceRuntime(context.Background(), runtime)
		if err != nil {
			// CAS: only transition to error if still in "creating" state.
			// If the workspace was stopped/deleted while provisioning, skip.
			s.casWorkspaceStatus(runtime.ID, []string{"creating"}, "error")

			callbackToken := s.callbackTokenForWorkspace(runtime.ID)
			if callbackToken != "" {
				if callbackErr := s.notifyWorkspaceProvisioningFailed(context.Background(), runtime.ID, callbackToken, err.Error()); callbackErr != nil {
					log.Printf("Workspace %s: provisioning-failed callback error: %v", runtime.ID, callbackErr)
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

		// CAS: only transition to running if still in "creating" state.
		// Prevents overwriting "stopped" if user stopped workspace during provisioning.
		if !s.casWorkspaceStatus(runtime.ID, []string{"creating"}, "running") {
			log.Printf("Workspace %s: provisioning completed but status already changed from creating, skipping running transition", runtime.ID)
			return
		}

		successDetail := make(map[string]interface{}, len(detail)+1)
		for key, value := range detail {
			successDetail[key] = value
		}
		if usedFallback {
			successDetail["devcontainerFallback"] = true
		}

		s.appendNodeEvent(runtime.ID, "info", successType, successMessage, successDetail)
	}()
}

func (s *Server) handleCreateWorkspace(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceID   string `json:"workspaceId"`
		Repository    string `json:"repository"`
		Branch        string `json:"branch"`
		CallbackToken string `json:"callbackToken,omitempty"`
		GitUserName   string `json:"gitUserName,omitempty"`
		GitUserEmail  string `json:"gitUserEmail,omitempty"`
	}

	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if body.WorkspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireNodeManagementAuth(w, r, body.WorkspaceID) {
		return
	}

	branch := strings.TrimSpace(body.Branch)
	if branch == "" {
		branch = "main"
	}

	runtime := s.upsertWorkspaceRuntime(body.WorkspaceID, strings.TrimSpace(body.Repository), branch, "creating", strings.TrimSpace(body.CallbackToken))
	runtime.GitUserName = strings.TrimSpace(body.GitUserName)
	runtime.GitUserEmail = strings.TrimSpace(body.GitUserEmail)
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
	if !s.casWorkspaceStatus(workspaceID, []string{"running", "creating", "error"}, "stopped") {
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

	// Clear persisted tabs — workspace is stopped, no live sessions remain
	if s.store != nil {
		if err := s.store.DeleteWorkspaceTabs(workspaceID); err != nil {
			log.Printf("Warning: failed to delete persisted tabs on workspace stop %s: %v", workspaceID, err)
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

	// CAS-style transition: only rebuild from running or error
	if !s.casWorkspaceStatus(workspaceID, []string{"running", "error"}, "creating") {
		writeJSON(w, http.StatusConflict, map[string]interface{}{
			"error":   "invalid_transition",
			"message": "Workspace must be running or in error state to rebuild, currently " + runtime.Status,
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

	// Remove the devcontainer and its Docker volume.
	// The container must be removed before the volume (Docker won't remove a volume in use).
	s.removeWorkspaceContainer(workspaceID)
	if err := bootstrap.RemoveVolume(context.Background(), workspaceID); err != nil {
		log.Printf("Warning: failed to remove Docker volume for workspace %s: %v", workspaceID, err)
	}

	s.removeWorkspaceRuntime(workspaceID)

	// Remove all persisted tabs for this workspace
	if s.store != nil {
		if err := s.store.DeleteWorkspaceTabs(workspaceID); err != nil {
			log.Printf("Warning: failed to delete persisted tabs for workspace %s: %v", workspaceID, err)
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
		log.Printf("Error listing tabs for workspace %s: %v", workspaceID, err)
		writeError(w, http.StatusInternalServerError, "failed to list tabs")
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"tabs": tabs})
}

func (s *Server) handleListAgentSessions(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}
	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"sessions": s.agentSessions.List(workspaceID),
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
		SessionID string `json:"sessionId"`
		Label     string `json:"label"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(body.SessionID) == "" {
		writeError(w, http.StatusBadRequest, "sessionId is required")
		return
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
				log.Printf("Warning: failed to persist chat tab: %v", err)
			}
		}
	}

	writeJSON(w, http.StatusCreated, session)
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
			log.Printf("Warning: failed to delete persisted chat tab: %v", err)
		}
	}

	s.appendNodeEvent(workspaceID, "info", "agent_session.stopped", "Agent session stopped", map[string]interface{}{"sessionId": sessionID})
	writeJSON(w, http.StatusOK, session)
}
