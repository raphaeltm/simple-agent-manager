package server

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
)

func (s *Server) handleListNodeEvents(w http.ResponseWriter, r *http.Request) {
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

// requireNodeEventAuth authenticates node-wide diagnostic requests.
//
// These routes expose node-wide observability state and raw diagnostic artifacts
// for every workspace on a node. They must therefore require a node-scoped
// management token minted by the control plane/operator. Workspace browser
// cookies and workspace-scoped management tokens are intentionally rejected.
func (s *Server) requireNodeEventAuth(w http.ResponseWriter, r *http.Request) bool {
	// Authorization takes precedence. A malformed/replayed bearer token must not
	// silently fall through to any weaker credential on the same request.
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if authHeader != "" {
		if !strings.HasPrefix(authHeader, "Bearer ") {
			writeError(w, http.StatusUnauthorized, "invalid Authorization header")
			return false
		}
		token := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
		if token == "" {
			writeError(w, http.StatusUnauthorized, "missing bearer token")
			return false
		}
		return s.requireNodeScopedManagementToken(w, r, token)
	}

	// WebSocket control-plane proxying uses ?token= because browsers cannot set
	// custom Authorization headers during a WebSocket upgrade.
	queryToken := strings.TrimSpace(r.URL.Query().Get("token"))
	if queryToken != "" {
		return s.requireNodeScopedManagementToken(w, r, queryToken)
	}

	writeError(w, http.StatusUnauthorized, "authentication required")
	return false
}

func (s *Server) requireNodeScopedManagementToken(w http.ResponseWriter, r *http.Request, token string) bool {
	claims, err := s.jwtValidator.ValidateNodeManagementToken(token, "")
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid management token")
		return false
	}
	if claims.Workspace != "" {
		writeError(w, http.StatusForbidden, "node-scoped management token required")
		return false
	}

	routedNode := s.routedNodeID(r)
	if routedNode != "" && routedNode != s.config.NodeID {
		writeError(w, http.StatusForbidden, "node route mismatch")
		return false
	}

	return true
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
	// Checkpoint WAL so the main .db file contains all data.
	if err := s.eventStore.Checkpoint(); err != nil {
		slog.Warn("eventstore: checkpoint before export failed", "error", err)
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
	// Checkpoint WAL so the main .db file contains all data.
	if err := s.resourceMonitor.Checkpoint(); err != nil {
		slog.Warn("resourcemon: checkpoint before export failed", "error", err)
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
