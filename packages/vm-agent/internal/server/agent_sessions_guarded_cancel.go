package server

import (
	"encoding/json"
	"io"
	"net/http"
)

// Separate endpoint is deliberate: old agents must return 404 rather than
// ignoring a new guard body on the legacy current-prompt cancellation route.
func (s *Server) handleGuardedCancelAgentSession(w http.ResponseWriter, r *http.Request) {
	workspaceID, sessionID := r.PathValue("workspaceId"), r.PathValue("sessionId")
	if workspaceID == "" || sessionID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId and sessionId are required")
		return
	}
	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return
	}
	var input struct {
		ExpectedPromptStartedAt int64 `json:"expectedPromptStartedAt"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || input.ExpectedPromptStartedAt <= 0 {
		writeError(w, http.StatusBadRequest, "expectedPromptStartedAt is required")
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, http.StatusBadRequest, "one JSON object is required")
		return
	}
	s.sessionHostMu.Lock()
	host := s.sessionHosts[workspaceID+":"+sessionID]
	s.sessionHostMu.Unlock()
	if host == nil {
		writeError(w, http.StatusNotFound, "no active agent session found")
		return
	}
	status := host.CancelPromptGuarded(input.ExpectedPromptStartedAt)
	if status == "unconfirmed" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": status})
		return
	}
	if status == "turn_changed" {
		writeJSON(w, http.StatusPreconditionFailed, map[string]string{"status": status})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": status})
}
