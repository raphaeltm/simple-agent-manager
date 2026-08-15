package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync/atomic"
	"time"
)

// --- Internal: helpers ---

func (h *SessionHost) currentSessionState() (SessionHostStatus, string, string) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.status, h.agentType, h.statusErr
}

// promptTimeout returns the configured prompt timeout. 0 means no timeout.
func (h *SessionHost) promptTimeout() time.Duration {
	return h.config.PromptTimeout
}

func (h *SessionHost) promptCancelGracePeriod() time.Duration {
	if h.config.PromptCancelGracePeriod > 0 {
		return h.config.PromptCancelGracePeriod
	}
	return DefaultPromptCancelGracePeriod
}

func (h *SessionHost) beginPrompt(cancel context.CancelFunc, observer PromptTerminalObserver) (*promptAttempt, bool) {
	h.promptMu.Lock()
	defer h.promptMu.Unlock()
	if h.promptInFlight {
		return nil, false
	}
	h.promptInFlight = true
	promptID := atomic.AddUint64(&h.promptSeq, 1)
	attempt := &promptAttempt{
		id:        promptID,
		startedAt: h.now(),
		cancel:    cancel,
		done:      make(chan struct{}),
		rpcDone:   make(chan struct{}),
		observer:  observer,
	}
	h.promptAttempt = attempt

	h.promptCancelMu.Lock()
	h.promptCancel = cancel
	h.activePromptID = promptID
	h.promptCancelRequested = false
	h.promptCancelMu.Unlock()
	return attempt, true
}

func (h *SessionHost) releasePrompt(attempt *promptAttempt) {
	h.promptMu.Lock()
	if h.promptAttempt == attempt {
		h.promptInFlight = false
	}
	h.promptMu.Unlock()

	h.promptCancelMu.Lock()
	if h.activePromptID == attempt.id {
		h.activePromptID = 0
		h.promptCancel = nil
		h.promptCancelRequested = false
	}
	h.promptCancelMu.Unlock()
}

func (h *SessionHost) promptAttemptForID(promptID uint64) *promptAttempt {
	h.promptMu.Lock()
	defer h.promptMu.Unlock()
	if h.promptAttempt != nil && h.promptAttempt.id == promptID {
		return h.promptAttempt
	}
	// Preserve the focused-test and upgrade seam for hosts whose prompt state
	// was established before the per-attempt arbiter existed.
	if h.promptInFlight {
		attempt := &promptAttempt{
			id:        promptID,
			startedAt: h.now(),
			done:      make(chan struct{}),
			rpcDone:   make(chan struct{}),
		}
		h.promptAttempt = attempt
		return attempt
	}
	return nil
}

func (h *SessionHost) activePromptStartedAt() (time.Time, bool) {
	h.promptMu.Lock()
	defer h.promptMu.Unlock()
	if !h.promptInFlight || h.promptAttempt == nil {
		return time.Time{}, false
	}
	return h.promptAttempt.startedAt, true
}

func (h *SessionHost) isPromptActive(promptID uint64) bool {
	h.promptCancelMu.Lock()
	defer h.promptCancelMu.Unlock()
	return h.activePromptID == promptID
}

func (h *SessionHost) isPromptCancelRequested(promptID uint64) bool {
	h.promptCancelMu.Lock()
	defer h.promptCancelMu.Unlock()
	return h.activePromptID == promptID && h.promptCancelRequested
}

func (h *SessionHost) watchPromptTimeout(
	promptID uint64,
	promptCtx context.Context,
	done <-chan struct{},
	viewerID string,
	reqID json.RawMessage,
	timeout time.Duration,
) {
	select {
	case <-done:
		return
	case <-promptCtx.Done():
		if !errors.Is(promptCtx.Err(), context.DeadlineExceeded) {
			return
		}
		msg := fmt.Sprintf("Prompt timed out after %s", timeout)
		h.sendJSONRPCErrorToViewer(viewerID, reqID, -32603, msg)
		h.triggerPromptForceStopIfStuck(promptID, msg)
	}
}

func (h *SessionHost) triggerPromptForceStopIfStuck(promptID uint64, reason string) {
	attempt := h.promptAttemptForID(promptID)
	stopReason := fatalErrorStopReason
	terminalErr := error(fmt.Errorf("%s", reason))
	if h.isPromptCancelRequested(promptID) {
		stopReason = "cancelled"
		terminalErr = context.Canceled
	}
	if attempt == nil {
		return
	}
	attempt.completeWith(h, stopReason, terminalErr, func() {
		h.mu.Lock()
		agentType := h.agentType
		if h.status == HostPrompting {
			h.status = HostError
			h.statusErr = reason
		}
		h.stopCurrentAgentLocked()
		h.mu.Unlock()

		h.reportLifecycle("error", "ACP prompt force-stopped", map[string]interface{}{
			"reason": reason,
		})
		h.broadcastControl(MsgSessionPromptDone, nil)
		h.broadcastAgentStatus(StatusError, agentType, reason)
		// A hard deadline is a terminal error, never an idle transition.
		h.stopPromptActivityRereport()
		h.reportActivity("error")
	})
}

func (h *SessionHost) setStatus(status SessionHostStatus, errMsg string) {
	h.mu.Lock()
	h.status = status
	h.statusErr = errMsg
	h.mu.Unlock()
}
