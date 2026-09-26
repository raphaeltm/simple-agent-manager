package server

import (
	"log/slog"
	"net/http"

	"github.com/workspace/vm-agent/internal/messagereport"
)

const terminalControlPlaneCallbackReason = "control plane returned terminal callback status"

// nodeIdentityCallback names a callback about the node itself. Only these may
// stop control-plane delivery for the whole node.
//
// Every other callback is about one project, task or workspace hosted here, and
// a terminal answer about one of those says nothing about the others sharing
// the machine. On 2026-09-25 a 410 for a single drained project's ACP heartbeat
// silenced heartbeats, error reports and all fourteen workspaces' transcripts
// on a live node for seven hours. The type is a struct so a per-resource caller
// cannot convert a string literal into it by accident.
type nodeIdentityCallback struct{ name string }

var (
	nodeReadyCallback     = nodeIdentityCallback{name: "node_ready"}
	nodeHeartbeatCallback = nodeIdentityCallback{name: "node_heartbeat"}
)

func isTerminalControlPlaneCallbackStatus(statusCode int) bool {
	switch statusCode {
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusGone:
		return true
	default:
		return false
	}
}

func (s *Server) controlPlaneCallbacksStopped() bool {
	if s == nil {
		return true
	}
	return s.callbacksTerminal.Load()
}

// markControlPlaneCallbacksTerminal records that the control plane has disowned
// this node: it rejected the node's own identity (401/403) or reports the node
// gone (404/410). Nothing the node sends can succeed after that, so every
// callback loop stops for the life of the process instead of retrying forever.
func (s *Server) markControlPlaneCallbacksTerminal(callback nodeIdentityCallback, statusCode int, responseBody string) {
	if s == nil {
		return
	}
	if !s.callbacksTerminal.CompareAndSwap(false, true) {
		return
	}

	slog.Warn("control-plane callbacks returned terminal status; stopping callback retries",
		"operation", callback.name,
		"statusCode", statusCode,
		"responseBody", responseBody,
	)
	if s.errorReporter != nil {
		s.errorReporter.MarkTerminal(terminalControlPlaneCallbackReason)
	}
	s.disableMessageReportersForTerminalCallbacks(callback, statusCode)
}

func (s *Server) disableMessageReportersForTerminalCallbacks(callback nodeIdentityCallback, statusCode int) {
	s.messageReportersMu.RLock()
	reporters := make(map[string]*messagereport.Reporter, len(s.messageReporters))
	for workspaceID, reporter := range s.messageReporters {
		reporters[workspaceID] = reporter
	}
	s.messageReportersMu.RUnlock()

	for workspaceID, reporter := range reporters {
		reporter.MarkTerminal(terminalControlPlaneCallbackReason)
		slog.Warn("message reporter disabled after terminal control-plane callback",
			"workspaceId", workspaceID,
			"operation", callback.name,
			"statusCode", statusCode,
		)
	}
}
