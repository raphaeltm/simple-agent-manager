package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
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
	return h.beginPromptForDelivery(context.Background(), cancel, "", observer)
}

func (h *SessionHost) beginPromptForDelivery(ctx context.Context, cancel context.CancelFunc, deliveryID string, observer PromptTerminalObserver) (*promptAttempt, bool) {
	h.promptMu.Lock()
	defer h.promptMu.Unlock()
	if h.promptInFlight {
		return nil, false
	}
	h.promptInFlight = true
	promptID := atomic.AddUint64(&h.promptSeq, 1)
	attempt := &promptAttempt{
		id:         promptID,
		ctx:        ctx,
		startedAt:  h.now(),
		cancel:     cancel,
		deliveryID: deliveryID,
		done:       make(chan struct{}),
		rpcDone:    make(chan struct{}),
		observer:   observer,
	}
	h.promptAttempt = attempt

	h.promptCancelMu.Lock()
	h.promptCancel = cancel
	h.activePromptID = promptID
	h.promptCancelRequested = false
	h.promptCancelMu.Unlock()
	return attempt, true
}

func (h *SessionHost) activePromptAttempt() (*promptAttempt, bool) {
	h.promptMu.Lock()
	defer h.promptMu.Unlock()
	if !h.promptInFlight || h.promptAttempt == nil {
		return nil, false
	}
	return h.promptAttempt, true
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

// promptAttemptByID returns the current attempt only when its identity
// matches. It never fabricates an attempt: in-flight prompt state does not
// survive a vm-agent restart, so an unknown ID is always a settled prompt.
func (h *SessionHost) promptAttemptByID(promptID uint64) *promptAttempt {
	h.promptMu.Lock()
	defer h.promptMu.Unlock()
	if h.promptAttempt != nil && h.promptAttempt.id == promptID {
		return h.promptAttempt
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
	attempt *promptAttempt,
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
		h.triggerPromptForceStopIfStuck(attempt, msg)
	}
}

// triggerPromptForceStopIfStuck acts only on the exact attempt a watchdog was
// armed for, and only while that attempt is still the current, non-terminal
// one. A watchdog outliving its attempt is a no-op: it must never touch a
// later prompt (see idea 01M31M9G3T4SEWT9ZW1BM4QKZ3).
func (h *SessionHost) triggerPromptForceStopIfStuck(attempt *promptAttempt, reason string) {
	if attempt == nil {
		return
	}
	h.promptMu.Lock()
	current := h.promptAttempt
	h.promptMu.Unlock()
	var currentID uint64
	if current != nil {
		currentID = current.id
	}
	cancelRequested := h.isPromptCancelRequested(attempt.id)
	fields := attempt.logFields(map[string]interface{}{
		"reason":          reason,
		"promptId":        attempt.id,
		"currentPromptId": currentID,
		"cancelRequested": cancelRequested,
	})
	if current != attempt || attempt.isTerminal() {
		slog.Info("ACP prompt force-stop skipped: attempt already settled",
			"promptId", attempt.id, "currentPromptId", currentID, "reason", reason)
		return
	}
	if cancelRequested {
		h.settleStuckPromptCancel(attempt, reason, fields)
		return
	}
	attempt.completeWith(h, fatalErrorStopReason, errors.New(reason), func() {
		h.mu.Lock()
		agentType := h.agentType
		if h.status == HostPrompting {
			h.setStatusLocked(HostError)
			h.statusErr = reason
		}
		h.stopCurrentAgentLocked()
		h.mu.Unlock()

		h.reportLifecycle("error", "ACP prompt force-stopped", fields)
		h.broadcastControl(MsgSessionPromptDone, nil)
		h.broadcastAgentStatus(StatusError, agentType, reason)
		// A hard deadline is a terminal error, never an idle transition.
		h.stopPromptActivityRereport()
		h.reportActivity("error")
	})
}

func (h *SessionHost) setStatus(status SessionHostStatus, errMsg string) {
	h.mu.Lock()
	h.setStatusLocked(status)
	h.statusErr = errMsg
	h.mu.Unlock()
}
