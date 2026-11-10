package server

// Workspace request routing, request authentication and the WebSocket reconnect gate.
// Moved out of workspace_routing.go (rule 18) with no behavior change.

import (
	"log/slog"
	"net/http"
	"strings"
)

func (s *Server) routedNodeID(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get("X-SAM-Node-Id"))
}

func (s *Server) routedWorkspaceID(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get("X-SAM-Workspace-Id"))
}

func (s *Server) requireWorkspaceRoute(w http.ResponseWriter, r *http.Request) (string, bool) {
	workspaceID := s.routedWorkspaceID(r)
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "missing X-SAM-Workspace-Id header")
		return "", false
	}
	return workspaceID, true
}

// requireWorkspaceOrManagementAuth admits either the workspace's own credentials (a session
// cookie, or a workspace token that also sets the cookie) or a control-plane management token.
// Workspace credentials are checked without writing a response first: requireWorkspaceRequestAuth
// writes a 401 on failure, and a later management-token success could not undo it.
func (s *Server) requireWorkspaceOrManagementAuth(w http.ResponseWriter, r *http.Request, workspaceID string) bool {
	if s.checkWorkspaceRequestAuth(r, workspaceID) {
		return s.requireWorkspaceRequestAuth(w, r, workspaceID)
	}
	return s.requireNodeManagementAuth(w, r, workspaceID)
}

func (s *Server) requireWorkspaceRequestAuth(w http.ResponseWriter, r *http.Request, workspaceID string) bool {
	routedWorkspace := s.routedWorkspaceID(r)
	if routedWorkspace != "" && routedWorkspace != workspaceID {
		writeError(w, http.StatusForbidden, "workspace route mismatch")
		return false
	}

	// Try workspace-scoped cookie first, then fall back to legacy cookie.
	session := s.sessionManager.GetSessionForWorkspace(r, workspaceID)
	if session != nil {
		if session.Claims == nil {
			// Invalid session — fall through to token auth instead of hard-failing.
			slog.Warn("session has nil claims, falling through to token auth",
				"workspaceID", workspaceID)
		} else if session.Claims.Workspace != "" && session.Claims.Workspace != workspaceID {
			// Cookie belongs to a different workspace — skip it and try token auth.
			// This happens when multiple workspaces share a node and the browser
			// sends the legacy (unscoped) cookie for a different workspace.
			slog.Debug("session cookie workspace mismatch, falling through to token auth",
				"workspaceID", workspaceID,
				"cookieWorkspace", session.Claims.Workspace)
		} else {
			// Valid session for this workspace
			return true
		}
	}

	// Try Authorization: Bearer header first, then fall back to ?token= query param.
	// The query param fallback exists because browser WebSocket upgrade requests cannot
	// set custom headers. Server-to-server calls (API proxy) MUST use Bearer header.
	token := ""
	if authHeader := r.Header.Get("Authorization"); strings.HasPrefix(authHeader, "Bearer ") {
		token = strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
	}
	if token == "" {
		token = strings.TrimSpace(r.URL.Query().Get("token"))
		if token != "" {
			slog.Debug("Auth token from query parameter (prefer Bearer header for non-WebSocket calls)",
				"workspace", workspaceID,
				"path", r.URL.Path,
			)
		}
	}
	if token == "" {
		writeError(w, http.StatusUnauthorized, "missing token")
		return false
	}

	claims, err := s.jwtValidator.ValidateWorkspaceToken(token, workspaceID)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid token")
		return false
	}

	createdSession, err := s.sessionManager.CreateSession(claims)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create session")
		return false
	}
	s.sessionManager.SetCookieForWorkspace(w, createdSession, workspaceID)
	return true
}

// checkWorkspaceRequestAuth is a non-writing variant of requireWorkspaceRequestAuth.
// It returns true if the request is authenticated for the given workspace, but does
// NOT write any HTTP error response on failure. This allows callers to try multiple
// auth methods without producing garbled double-write responses.
func (s *Server) checkWorkspaceRequestAuth(r *http.Request, workspaceID string) bool {
	routedWorkspace := s.routedWorkspaceID(r)
	if routedWorkspace != "" && routedWorkspace != workspaceID {
		return false
	}

	// Try workspace-scoped cookie first, then fall back to legacy cookie.
	session := s.sessionManager.GetSessionForWorkspace(r, workspaceID)
	if session != nil {
		if session.Claims != nil &&
			(session.Claims.Workspace == "" || session.Claims.Workspace == workspaceID) {
			return true
		}
	}

	// Try Authorization: Bearer header first, then fall back to ?token= query param.
	token := ""
	if authHeader := r.Header.Get("Authorization"); strings.HasPrefix(authHeader, "Bearer ") {
		token = strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
	}
	if token == "" {
		token = strings.TrimSpace(r.URL.Query().Get("token"))
	}
	if token == "" {
		return false
	}

	_, err := s.jwtValidator.ValidateWorkspaceToken(token, workspaceID)
	return err == nil
}

func (s *Server) requireWorkspaceReconnectState(w http.ResponseWriter, r *http.Request, runtime *WorkspaceRuntime) bool {
	lock := s.workspaceLifecycleLock(runtime.ID)
	if err := lock.Lock(r.Context()); err != nil {
		writeError(w, http.StatusRequestTimeout, "workspace lifecycle operation canceled")
		return false
	}
	defer lock.Unlock()
	snapshot, err := s.refreshWorkspaceEvictionState(runtime)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return false
	}
	if snapshot.Status == "evicted" {
		writeError(w, http.StatusConflict, "workspace was evicted; restart it before reconnecting")
		return false
	}
	return true
}
