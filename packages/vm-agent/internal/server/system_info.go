package server

import (
	"log/slog"
	"net/http"

	"github.com/workspace/vm-agent/internal/publish"
	"github.com/workspace/vm-agent/internal/sysinfo"
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
		slog.Error("System info collection error", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to collect system info")
		return
	}

	// The collector caches slow Docker/system metrics. Read execution counters
	// separately so before/after observations cannot reuse that cached snapshot.
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, struct {
		*sysinfo.SystemInfo
		PublishExecution publish.ExecutionSnapshot `json:"publishExecution"`
	}{info, publish.ExecutionCounters()})
}
