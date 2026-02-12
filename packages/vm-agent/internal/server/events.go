package server

import (
	"net/http"
	"strconv"
)

func (s *Server) handleListNodeEvents(w http.ResponseWriter, r *http.Request) {
	if !s.requireNodeManagementAuth(w, r, "") {
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

	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return
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
