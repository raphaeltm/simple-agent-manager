package server

import (
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
)

func (s *Server) handleListNodeEvents(w http.ResponseWriter, r *http.Request) {
	// Accept browser-facing auth: workspace request auth (any workspace on this node
	// proves node ownership) or management token via Authorization header / ?token= query param.
	if !s.requireNodeEventAuth(w, r) {
		return
	}
	limit := parseEventLimit(r.URL.Query().Get("limit"))

	s.eventMu.RLock()
	defer s.eventMu.RUnlock()

	result := s.nodeEvents
	if len(result) > limit {
		result = result[:limit]
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"events":     result,
		"nextCursor": nil,
	})
}

func (s *Server) handleListWorkspaceEvents(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	// Accept both workspace session auth (browser direct call with ?token= or cookie)
	// and management auth (control-plane proxy), matching handleListTabs pattern.
	// Check workspace auth first without writing an error response, then try
	// management auth. Only write a single error if both fail.
	if !s.checkWorkspaceRequestAuth(r, workspaceID) {
		if !s.requireNodeManagementAuth(w, r, workspaceID) {
			return
		}
	}

	limit := parseEventLimit(r.URL.Query().Get("limit"))

	s.eventMu.RLock()
	defer s.eventMu.RUnlock()

	workspaceEvents := s.workspaceEvents[workspaceID]
	if len(workspaceEvents) > limit {
		workspaceEvents = workspaceEvents[:limit]
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"events":     workspaceEvents,
		"nextCursor": nil,
	})
}

// requireNodeEventAuth authenticates node-level event requests.
// Accepts:
// 1. Node management token via Authorization header (control-plane proxy)
// 2. Node management token via ?token= query parameter (browser direct call)
// 3. Any valid workspace session cookie for a workspace on this node (browser)
func (s *Server) requireNodeEventAuth(w http.ResponseWriter, r *http.Request) bool {
	// Try management token from Authorization header first (existing pattern).
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if authHeader != "" && strings.HasPrefix(authHeader, "Bearer ") {
		token := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
		if token != "" {
			claims, err := s.jwtValidator.ValidateNodeManagementToken(token, "")
			if err == nil {
				routedNode := s.routedNodeID(r)
				if routedNode == "" || routedNode == s.config.NodeID {
					_ = claims
					return true
				}
			}
		}
	}

	// Try management token from ?token= query parameter (browser direct call).
	queryToken := strings.TrimSpace(r.URL.Query().Get("token"))
	if queryToken != "" {
		claims, err := s.jwtValidator.ValidateNodeManagementToken(queryToken, "")
		if err == nil {
			_ = claims
			return true
		}
	}

	// Try workspace session cookie — any valid workspace session for this node proves access.
	session := s.sessionManager.GetSessionFromRequest(r)
	if session != nil && session.Claims != nil && session.Claims.Workspace != "" {
		return true
	}

	writeError(w, http.StatusUnauthorized, "authentication required")
	return false
}

func parseEventLimit(raw string) int {
	if raw == "" {
		return 100
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed <= 0 {
		return 100
	}
	if parsed > 500 {
		return 500
	}
	return parsed
}

// handleExportEvents streams the raw SQLite event database file as a download.
func (s *Server) handleExportEvents(w http.ResponseWriter, r *http.Request) {
	if !s.requireNodeEventAuth(w, r) {
		return
	}
	if s.eventStore == nil {
		writeError(w, http.StatusServiceUnavailable, "event store not available")
		return
	}
	serveDBFile(w, r, s.eventStore.DBPath(), fmt.Sprintf("events-%s.db", s.config.NodeID))
}

// handleExportMetrics streams the raw SQLite metrics database file as a download.
func (s *Server) handleExportMetrics(w http.ResponseWriter, r *http.Request) {
	if !s.requireNodeEventAuth(w, r) {
		return
	}
	if s.resourceMonitor == nil {
		writeError(w, http.StatusServiceUnavailable, "resource monitor not available")
		return
	}
	serveDBFile(w, r, s.resourceMonitor.DBPath(), fmt.Sprintf("metrics-%s.db", s.config.NodeID))
}

// serveDBFile sends a SQLite database file as an attachment download.
func serveDBFile(w http.ResponseWriter, r *http.Request, dbPath, filename string) {
	f, err := os.Open(dbPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to open database file")
		return
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to stat database file")
		return
	}

	w.Header().Set("Content-Type", "application/x-sqlite3")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	w.Header().Set("Content-Length", strconv.FormatInt(stat.Size(), 10))
	http.ServeContent(w, r, filename, stat.ModTime(), f)
}
