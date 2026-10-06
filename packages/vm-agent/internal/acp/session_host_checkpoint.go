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
			episode.complete(result, true)
			_ = process.Stop()
			attempt.complete(h, fatalErrorStopReason, errors.New(message))
			h.setStatus(HostError, message)
			h.stopPromptActivityRereport()
			h.reportActivity("error")
			return result, ctx.Err()
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
		episode.complete(result, true)
		attempt.completeCheckpoint(h, fatalErrorStopReason, errors.New(message))
		h.setStatus(HostError, message)
		h.reportActivity("error")
		return result, fmt.Errorf("%w: %s", ErrCheckpointUnavailable, message)
	}
	episode.forced = forced
	h.mu.Unlock()

	if err := process.Stop(); err != nil {
		message := "failed to stop agent process for checkpoint rollover"
		result := CheckpointRolloverResult{State: "failed", Forced: forced, ACPSessionID: episode.sessionID,
			ErrorCode: "process_stop_failed", ErrorMessage: message}
		episode.complete(result, true)
		attempt.completeCheckpoint(h, fatalErrorStopReason, fmt.Errorf("%s: %w", message, err))
		h.setStatus(HostError, message)
		h.reportActivity("error")
		return result, fmt.Errorf("%s: %w", message, err)
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
		if !episode.complete(result, true) {
			result = <-episode.result
			if result.State == "failed" {
				return result, errors.New(result.ErrorMessage)
			}
			return result, nil
		}
		attempt.completeCheckpoint(h, fatalErrorStopReason, errors.New(message))
		h.setStatus(HostError, message)
		h.reportActivity("error")
		return result, ctx.Err()
	}
}

func (h *SessionHost) clearCheckpointRollover(episode *checkpointRolloverEpisode) {
	h.mu.Lock()
	if h.checkpointRollover == episode {
		h.checkpointRollover = nil
	}
	h.mu.Unlock()
}
