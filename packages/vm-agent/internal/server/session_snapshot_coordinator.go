package server

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

func (s *Server) sessionSnapshotLock(chatSessionID string) *sync.Mutex {
	s.sessionSnapshotMu.Lock()
	defer s.sessionSnapshotMu.Unlock()
	if s.sessionSnapshotLocks == nil {
		s.sessionSnapshotLocks = make(map[string]*sync.Mutex)
	}
	lock := s.sessionSnapshotLocks[chatSessionID]
	if lock == nil {
		lock = &sync.Mutex{}
		s.sessionSnapshotLocks[chatSessionID] = lock
	}
	return lock
}

func (s *Server) runSessionSnapshot(ctx context.Context, input *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
	if s.sessionSnapshotRunner != nil {
		return s.sessionSnapshotRunner(ctx, input)
	}
	return s.hibernateSessionSnapshot(
		ctx,
		input.runtime,
		input.sessionID,
		input.chatSessionID,
		input.runtimeName,
		input.agentType,
		input.callbackToken,
	)
}

func (s *Server) captureSessionSnapshot(ctx context.Context, input *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
	lock := s.sessionSnapshotLock(input.chatSessionID)
	lock.Lock()
	defer lock.Unlock()
	return s.runSessionSnapshot(ctx, input)
}

func (s *Server) sessionSnapshotOperationTimeout() time.Duration {
	if s.config != nil && s.config.SessionSnapshotOperationTimeout > 0 {
		return s.config.SessionSnapshotOperationTimeout
	}
	return config.DefaultSessionSnapshotOperationTimeout
}

func (s *Server) startBackgroundSessionSnapshot(input *sessionSnapshotHandlerInput) bool {
	lock := s.sessionSnapshotLock(input.chatSessionID)
	if !lock.TryLock() {
		return false
	}
	go func() {
		defer lock.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), s.sessionSnapshotOperationTimeout())
		defer cancel()
		result, err := s.runSessionSnapshot(ctx, input)
		if err != nil {
			slog.Warn("Background session snapshot failed", "chatSessionId", input.chatSessionID, "workspaceId", input.workspaceID, "error", err)
			if generation := snapshotCaptureErrorGeneration(err); generation != "" {
				reportCtx, reportCancel := context.WithTimeout(context.Background(), s.sessionSnapshotProgressReportTimeout())
				if reportErr := s.reportSnapshotFailure(reportCtx, input.workspaceID, input.chatSessionID, generation, err.Error(), input.callbackToken); reportErr != nil {
					slog.Warn("Session snapshot failure report failed", "chatSessionId", input.chatSessionID, "workspaceId", input.workspaceID, "generation", generation, "error", reportErr)
				}
				reportCancel()
			}
			if s.errorReporter != nil && shouldReportBackgroundSnapshotIncident(err) {
				s.errorReporter.ReportError(err, "session_snapshot.background_capture", input.workspaceID, map[string]interface{}{
					"chatSessionId": input.chatSessionID,
					"sessionId":     input.sessionID,
					"runtime":       input.runtimeName,
					"agentType":     input.agentType,
				})
			}
			return
		}
		slog.Info("Background session snapshot completed", "chatSessionId", input.chatSessionID, "workspaceId", input.workspaceID, "result", result)
	}()
	return true
}

// isSnapshotTeardownRaceError reports whether a capture failed only because the workspace
// it was snapshotting had already been torn down.
//
// A background capture races teardown by design: startBackgroundSessionSnapshot returns as
// soon as the goroutine is running and the handler answers 202, so the workspace is free to
// stop while the capture is still in flight. Losing that race is the expected terminal state,
// not a fault — the authoritative snapshot was already written by the sleep path that stopped
// the workspace in the first place.
//
// This composes isContainerUnavailableError rather than extending it, because that predicate
// is a recovery trigger for three unrelated call sites.
func isSnapshotTeardownRaceError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, errWorkspaceRuntimeNotFound) || isContainerUnavailableError(err) {
		return true
	}
	// Only "stopped" is deliberate teardown. Production evidence covers that status alone, so
	// per .claude/rules/67 this filters the narrowest set the evidence supports: a snapshot that
	// fails while the workspace is "creating" (e.g. racing a restart) or "error" keeps reporting.
	var notRunning *workspaceNotRunningError
	return errors.As(err, &notRunning) && notRunning.status == workspaceStatusStopped
}

// shouldReportBackgroundSnapshotIncident decides whether a failed background capture is worth
// raising as a platform error incident.
//
// Only the teardown race is filtered. Everything else — including a capture that exceeds
// SessionSnapshotOperationTimeout — still reports, because a snapshot that fails to preserve
// resumable state must stay visible.
func shouldReportBackgroundSnapshotIncident(err error) bool {
	if err == nil {
		return false
	}
	return !isSnapshotTeardownRaceError(err)
}
