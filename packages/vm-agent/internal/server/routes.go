// Package server provides HTTP route handlers.
package server

import (
	"encoding/json"
	"net/http"
	"regexp"
)

// handleHealth handles the health check endpoint.
// This endpoint is unauthenticated (used for monitoring/liveness checks),
// so it MUST NOT expose workspace IDs or other sensitive data.
func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	response := map[string]interface{}{
		"status": "healthy",
	}
	writeJSON(w, http.StatusOK, response)
}

// handleTerminalResize handles terminal resize requests.
func (s *Server) handleTerminalResize(w http.ResponseWriter, r *http.Request) {
	workspaceID := s.routedWorkspaceID(r)
	session := s.sessionManager.GetSessionForWorkspace(r, workspaceID)
	if session == nil {
		writeError(w, http.StatusUnauthorized, "not authenticated")
		return
	}

	if session.Claims == nil || session.Claims.Workspace == "" {
		writeError(w, http.StatusUnauthorized, "invalid session claims")
		return
	}
	workspaceID = session.Claims.Workspace
	runtime, ok := s.getWorkspaceRuntime(workspaceID)
	if !ok {
		writeError(w, http.StatusNotFound, "workspace not found")
		return
	}

	var body struct {
		SessionID string `json:"sessionId"`
		Rows      int    `json:"rows"`
		Cols      int    `json:"cols"`
	}

	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if body.SessionID == "" {
		writeError(w, http.StatusBadRequest, "sessionId is required")
		return
	}

	ptySession := runtime.PTY.GetSession(body.SessionID)
	if ptySession == nil {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}

	if ptySession.UserID != session.UserID {
		writeError(w, http.StatusForbidden, "not authorized")
		return
	}

	if err := ptySession.Resize(body.Rows, body.Cols); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to resize terminal")
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

// writeJSON writes a JSON response.
func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

// writeError writes an error response.
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{
		"error": message,
	})
}

// containerIDRe matches Docker container IDs (12-64 hex chars) and container
// names (alphanumeric with hyphens, underscores, and dots per Docker naming rules).
var containerIDRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,253}$`)

// isValidContainerID checks that a container ID or name matches the expected
// Docker format to prevent command injection via crafted container identifiers.
func isValidContainerID(id string) bool {
	return id != "" && containerIDRe.MatchString(id)
}
