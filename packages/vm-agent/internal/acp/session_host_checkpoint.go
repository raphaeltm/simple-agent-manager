package acp

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

const checkpointPreemptedStopReason = "checkpoint_preempted"

var (
	ErrCheckpointUnavailable = errors.New("checkpoint rollover is unavailable")
	ErrCheckpointInProgress  = errors.New("checkpoint rollover is already in progress")
)

// CheckpointRolloverResult is the outcome of a graceful agent-process rollover.
// Superseded means natural completion or an explicit user cancellation won the
// terminal race and no process restart was performed.
type CheckpointRolloverResult struct {
	State        string `json:"state"`
	Forced       bool   `json:"forced"`
	ACPSessionID string `json:"acpSessionId,omitempty"`
	ErrorCode    string `json:"errorCode,omitempty"`
	ErrorMessage string `json:"errorMessage,omitempty"`
}

// CheckpointRollover cancels and closes the current ACP turn, waits a bounded
// grace, force-stops if needed, restarts the harness, and strictly LoadSessions
// the same ACP session. It never falls back to NewSession.
func (h *SessionHost) CheckpointRollover(ctx context.Context, grace time.Duration) (CheckpointRolloverResult, error) {
	h.mu.Lock()
	h.promptMu.Lock()
	attempt := h.promptAttempt
	active := h.promptInFlight && attempt != nil
	if h.checkpointRollover != nil {
		h.promptMu.Unlock()
		h.mu.Unlock()
		return CheckpointRolloverResult{}, ErrCheckpointInProgress
	}
	if !active || h.status != HostPrompting || h.process == nil || h.acpConn == nil ||
		h.sessionID == "" || !h.agentSupportsLoadSession {
		h.promptMu.Unlock()
		h.mu.Unlock()
		return CheckpointRolloverResult{}, ErrCheckpointUnavailable
	}
	episode := &checkpointRolloverEpisode{
		sessionID:    string(h.sessionID),
		attempt:      attempt,
		result:       make(chan CheckpointRolloverResult, 1),
		operationCtx: ctx,
	}
	process := h.process
	conn := h.acpConn
	sessionID := h.sessionID
	h.checkpointRollover = episode
	attempt.checkpointRequested.Store(true)
	h.promptMu.Unlock()
	h.mu.Unlock()
	graceStartedAt := h.now()

	// Cancel is mandatory ACP baseline behavior. Cancelling the Prompt context
	// also causes the SDK to emit session/cancel, covering adapters that race the
	// explicit notification. Close is best-effort because it is an optional ACP
	// capability; force-stop remains the bounded fallback.
	if err := conn.Cancel(ctx, acpsdk.CancelNotification{SessionId: sessionID}); err != nil {
		slog.Warn("Checkpoint rollover ACP cancel failed; continuing to bounded fallback", "error", err)
	}
	attempt.cancel()
	closeCtx := ctx
	var closeCancel context.CancelFunc
	if grace > 0 {
		closeCtx, closeCancel = context.WithTimeout(ctx, grace)
		defer closeCancel()
	}
	if _, err := conn.CloseSession(closeCtx, acpsdk.CloseSessionRequest{SessionId: sessionID}); err != nil {
		slog.Info("Checkpoint rollover ACP close unavailable; continuing to process fallback", "error", err)
	}

	forced := false
	select {
	case <-attempt.done:
		h.clearCheckpointRollover(episode)
		return CheckpointRolloverResult{State: "superseded", ACPSessionID: episode.sessionID}, nil
	default:
	}
	remainingGrace := grace - h.now().Sub(graceStartedAt)
	if remainingGrace <= 0 {
		forced = true
	} else {
		timer := time.NewTimer(remainingGrace)
		defer timer.Stop()
		select {
		case <-attempt.done:
			h.clearCheckpointRollover(episode)
			return CheckpointRolloverResult{State: "superseded", ACPSessionID: episode.sessionID}, nil
		case <-attempt.rpcDone:
			select {
			case <-attempt.done:
				h.clearCheckpointRollover(episode)
				return CheckpointRolloverResult{State: "superseded", ACPSessionID: episode.sessionID}, nil
			default:
			}
		case <-timer.C:
			forced = true
		case <-ctx.Done():
			message := "checkpoint rollover cancelled before process restart"
			result := CheckpointRolloverResult{State: "failed", ACPSessionID: episode.sessionID,
				ErrorCode: "rollover_cancelled", ErrorMessage: message}
			_ = process.Stop()
			return h.resolveCheckpointFailure(episode, result, ctx.Err(), false)
		}
	}
	select {
	case <-attempt.done:
		h.clearCheckpointRollover(episode)
		return CheckpointRolloverResult{State: "superseded", ACPSessionID: episode.sessionID}, nil
	default:
	}
	if h.config.BeforeCheckpointProcessStop != nil {
		h.config.BeforeCheckpointProcessStop()
	}
	if !attempt.claimCheckpointTerminal() {
		h.clearCheckpointRollover(episode)
		return CheckpointRolloverResult{State: "superseded", ACPSessionID: episode.sessionID}, nil
	}

	h.mu.Lock()
	if h.checkpointRollover != episode || h.process != process {
		h.mu.Unlock()
		message := "agent process changed during checkpoint rollover"
		result := CheckpointRolloverResult{State: "failed", Forced: forced, ACPSessionID: episode.sessionID,
			ErrorCode: "process_changed", ErrorMessage: message}
		return h.resolveCheckpointFailure(episode, result, fmt.Errorf("%w: %s", ErrCheckpointUnavailable, message), true)
	}
	episode.forced = forced
	h.mu.Unlock()

	if err := process.Stop(); err != nil {
		message := "failed to stop agent process for checkpoint rollover"
		result := CheckpointRolloverResult{State: "failed", Forced: forced, ACPSessionID: episode.sessionID,
			ErrorCode: "process_stop_failed", ErrorMessage: message}
		return h.resolveCheckpointFailure(episode, result, fmt.Errorf("%s: %w", message, err), true)
	}

	select {
	case result := <-episode.result:
		if result.State == "failed" {
			return result, errors.New(result.ErrorMessage)
		}
		return result, nil
	case <-ctx.Done():
		message := "checkpoint rollover did not converge before its operation deadline"
		result := CheckpointRolloverResult{State: "failed", Forced: forced, ACPSessionID: episode.sessionID,
			ErrorCode: "rollover_deadline_exceeded", ErrorMessage: message}
		return h.resolveCheckpointFailure(episode, result, ctx.Err(), true)
	}
}

// publishCheckpointFailure keeps the checkpoint outcome and its prompt verdict
// together while eviction owns the runtime. Rollback/expiry replay the failure;
// a committed eviction supersedes the episode and wakes its waiting caller.
func (h *SessionHost) publishCheckpointFailure(episode *checkpointRolloverEpisode, result CheckpointRolloverResult, cause error, owned bool) {
	if episode.supersedeIfSettled(h, h.checkpointTeardownStarted()) {
		return
	}
	publish := func() {
		if episode.completeFailure(h, result, cause, owned) {
			h.mu.Lock()
			if h.checkpointRollover == episode && h.process == nil {
				h.checkpointRollover = nil
			}
			h.setStatusLocked(HostError)
			h.statusErr = result.ErrorMessage
			h.mu.Unlock()
			h.stopPromptActivityRereport()
			h.reportActivity("error")
		}
	}
	replay := func() { h.dispatchCheckpointFailure(episode, result, cause, owned) }
	if !h.parkPromptCrashForEviction("checkpoint_failed", replay, episode.attempt) {
		publish()
	} else {
		// The park guard also consumes stale callbacks; resolve their waiting caller.
		episode.supersedeIfSettled(h, h.checkpointTeardownStarted())
	}
}

// Stop latches teardown before changing status or running cancellation callbacks.
func (h *SessionHost) checkpointTeardownStarted() bool {
	h.evictionReportMu.Lock()
	defer h.evictionReportMu.Unlock()
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.evictionTeardown || h.status == HostStopped
}

// Process-exit handling already owns this decision lock; checkpoint callers and
// detached replays enter here so a renewed fence cannot lose terminal ownership.
func (h *SessionHost) dispatchCheckpointFailure(episode *checkpointRolloverEpisode, result CheckpointRolloverResult, cause error, owned bool) {
	h.evictionDecisionMu.Lock()
	defer h.evictionDecisionMu.Unlock()
	h.publishCheckpointFailure(episode, result, cause, owned)
}

func (h *SessionHost) resolveCheckpointFailure(episode *checkpointRolloverEpisode, result CheckpointRolloverResult, cause error, owned bool) (CheckpointRolloverResult, error) {
	h.dispatchCheckpointFailure(episode, result, cause, owned)
	decided := <-episode.result
	if decided.State == "failed" {
		return decided, cause
	}
	return decided, nil
}

func (h *SessionHost) clearCheckpointRollover(episode *checkpointRolloverEpisode) {
	h.mu.Lock()
	if h.checkpointRollover == episode {
		h.checkpointRollover = nil
	}
	h.mu.Unlock()
}
