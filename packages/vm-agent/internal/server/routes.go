// Package server provides HTTP route handlers.
package server

import (
	"encoding/json"
	"log"
	"net/http"
)

// handleHealth handles the health check endpoint.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	response := map[string]interface{}{
		"status":      "healthy",
		"workspaceId": s.config.WorkspaceID,
		"sessions":    s.ptyManager.SessionCount(),
		"idle":        s.idleDetector.GetIdleTime().String(),
	}
	writeJSON(w, http.StatusOK, response)
}

// handleTokenAuth handles JWT token authentication.
func (s *Server) handleTokenAuth(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"token"`
	}

	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if body.Token == "" {
		writeError(w, http.StatusBadRequest, "token is required")
		return
	}

	// Validate JWT
	claims, err := s.jwtValidator.Validate(body.Token)
	if err != nil {
		log.Printf("Token validation failed: %v", err)
		writeError(w, http.StatusUnauthorized, "invalid token")
		return
	}

	// Create session
	session, err := s.sessionManager.CreateSession(claims)
	if err != nil {
		log.Printf("Failed to create session: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to create session")
		return
	}

	// Set session cookie
	s.sessionManager.SetCookie(w, session)

	// Record activity
	s.idleDetector.RecordActivity()

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":   true,
		"sessionId": session.ID,
		"userId":    session.UserID,
		"expiresAt": session.ExpiresAt.Format(http.TimeFormat),
	})
}

// handleSessionCheck handles session validation.
func (s *Server) handleSessionCheck(w http.ResponseWriter, r *http.Request) {
	session := s.sessionManager.GetSessionFromRequest(r)
	if session == nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"authenticated": false,
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"authenticated": true,
		"userId":        session.UserID,
		"sessionId":     session.ID,
		"expiresAt":     session.ExpiresAt.Format(http.TimeFormat),
	})
}

// handleLogout handles session logout.
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	session := s.sessionManager.GetSessionFromRequest(r)
	if session != nil {
		// Close any PTY sessions for this user
		_ = s.ptyManager.CloseUserSessions(session.UserID)

		// Delete session
		s.sessionManager.DeleteSession(session.ID)
	}

	// Clear cookie
	s.sessionManager.ClearCookie(w)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
	})
}

// handleTerminalResize handles terminal resize requests.
func (s *Server) handleTerminalResize(w http.ResponseWriter, r *http.Request) {
	session := s.sessionManager.GetSessionFromRequest(r)
	if session == nil {
		writeError(w, http.StatusUnauthorized, "not authenticated")
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

	ptySession := s.ptyManager.GetSession(body.SessionID)
	if ptySession == nil {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}

	// Verify ownership
	if ptySession.UserID != session.UserID {
		writeError(w, http.StatusForbidden, "not authorized")
		return
	}

	if err := ptySession.Resize(body.Rows, body.Cols); err != nil {
		log.Printf("Failed to resize terminal: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to resize terminal")
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
	})
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
