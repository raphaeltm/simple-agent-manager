package server

import (
	"log/slog"
	"net/http"

	"github.com/workspace/vm-agent/internal/messagereport"
)

const terminalControlPlaneCallbackReason = "control plane returned terminal callback status"

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

func (s *Server) markControlPlaneCallbacksTerminal(operation string, statusCode int, responseBody string) {
	if s == nil {
		return
	}
	if !s.callbacksTerminal.CompareAndSwap(false, true) {
		return
	}

	slog.Warn("control-plane callbacks returned terminal status; stopping callback retries",
		"operation", operation,
		"statusCode", statusCode,
		"responseBody", responseBody,
	)
	if s.errorReporter != nil {
		s.errorReporter.MarkTerminal(terminalControlPlaneCallbackReason)
	}
	s.disableMessageReportersForTerminalCallbacks(operation, statusCode)
}

func (s *Server) disableMessageReportersForTerminalCallbacks(operation string, statusCode int) {
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
			"operation", operation,
			"statusCode", statusCode,
		)
	}
}
