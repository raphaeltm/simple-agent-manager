package server

import (
	"log"
	"net/http"
)

// handleSystemInfo returns full system metrics for the node.
// Uses the same auth as GET /events (node event auth).
func (s *Server) handleSystemInfo(w http.ResponseWriter, r *http.Request) {
	if !s.requireNodeEventAuth(w, r) {
		return
	}

	if s.sysInfoCollector == nil {
		writeError(w, http.StatusServiceUnavailable, "system info collector not initialized")
		return
	}

	info, err := s.sysInfoCollector.Collect()
	if err != nil {
		log.Printf("System info collection error: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to collect system info")
		return
	}

	writeJSON(w, http.StatusOK, info)
}
