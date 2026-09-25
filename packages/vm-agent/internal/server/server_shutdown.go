package server

import (
	"context"
	"log/slog"
)

// Stop gracefully stops the server.
func (s *Server) Stop(ctx context.Context) error {
	s.stopOnce.Do(func() {
		// Signal background goroutines to stop.
		close(s.done)
		s.cancelAndWaitSessionRestores()
		s.resourceHistoryStarted.Store(false)
		s.stopAllResourceHistoryCollectors(ctx)

		// Stop all port scanners
		s.stopAllPortScanners()

		// Stop browser auth session cleanup.
		s.sessionManager.Stop()

		// Close JWT validator
		s.jwtValidator.Close()

		s.sessionHostMu.Lock()
		for key, host := range s.sessionHosts {
			if host != nil {
				host.Stop()
			}
			delete(s.sessionHosts, key)
		}
		s.sessionHostMu.Unlock()

		// Close all workspace PTY sessions.
		s.workspaceMu.Lock()
		for _, runtime := range s.workspaces {
			runtime.PTY.CloseAllSessions()
		}
		s.workspaceMu.Unlock()

		// Flush and stop error reporter
		s.errorReporter.Shutdown()

		// Flush and stop all per-workspace message reporters
		s.shutdownAllReporters()

		if s.resourceEviction != nil {
			s.resourceEviction.Close()
		}

		if s.resourceGuard != nil {
			if err := s.resourceGuard.Close(); err != nil {
				slog.Warn("Failed to close resource guard", "error", err)
			}
		}

		if s.resourceMonitor != nil {
			if err := s.resourceMonitor.Close(); err != nil {
				slog.Warn("Failed to close resource monitor", "error", err)
			}
		}

		// Close persistence store
		if s.store != nil {
			if err := s.store.Close(); err != nil {
				slog.Warn("Failed to close persistence store", "error", err)
			}
		}

		// Shutdown HTTP server
		stopErr := s.httpServer.Shutdown(ctx)
		s.stopErrMu.Lock()
		s.stopErr = stopErr
		s.stopErrMu.Unlock()
	})
	s.stopErrMu.Lock()
	defer s.stopErrMu.Unlock()
	return s.stopErr
}
