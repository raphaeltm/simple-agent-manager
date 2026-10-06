package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"syscall"
	"time"
)

// CancelPrompt cancels the currently running Prompt() call, if any.
// This is safe to call from any goroutine. If no prompt is in flight,
// it's a no-op. The cancel function is guarded by promptCancelMu
// (separate from promptMu) so we never deadlock with HandlePrompt.
func (h *SessionHost) CancelPrompt() {
	h.cancelPrompt(true)
}

// CancelPromptFromControlPlane mirrors the viewer WebSocket session/cancel path
// for HTTP control-plane cancellation requests.
func (h *SessionHost) CancelPromptFromControlPlane() {
	if h.AgentType() == "opencode" {
		h.cancelPrompt(false)
		h.StopProcessForPromptCancel()
		return
	}

	h.CancelPrompt()
	cancelMessage, err := h.cancelNotification()
	if err != nil {
		slog.Warn("CancelPromptFromControlPlane: could not build session/cancel notification", "error", err)
	} else {
		h.ForwardToAgent(cancelMessage)
	}
	h.StopProcessForPromptCancel()
}

func (h *SessionHost) cancelNotification() ([]byte, error) {
	sessionID := h.currentSessionIDForCancel()
	if sessionID == "" {
		return nil, fmt.Errorf("missing session ID")
	}

	return json.Marshal(struct {
		JSONRPC string `json:"jsonrpc"`
		Method  string `json:"method"`
		Params  struct {
			SessionID string `json:"sessionId"`
		} `json:"params"`
	}{
		JSONRPC: "2.0",
		Method:  "session/cancel",
		Params: struct {
			SessionID string `json:"sessionId"`
		}{SessionID: sessionID},
	})
}

func (h *SessionHost) currentSessionIDForCancel() string {
	h.mu.RLock()
	acpSessionID := string(h.sessionID)
	h.mu.RUnlock()
	if acpSessionID != "" {
		return acpSessionID
	}
	return h.config.SessionID
}

func (h *SessionHost) cancelPrompt(startGraceTimer bool) {
	h.promptCancelMu.Lock()
	cancelFn := h.promptCancel
	promptID := h.activePromptID
	if cancelFn != nil {
		h.promptCancelRequested = true
	}
	h.promptCancelMu.Unlock()

	if cancelFn == nil {
		slog.Info("CancelPrompt: no prompt in flight")
		return
	}

	// Resolve the exact attempt being cancelled. promptMu is taken only after
	// promptCancelMu is released (beginPrompt nests them the other way round).
	// If the attempt already settled and a newer one began in between, the
	// lookup misses and no watchdog is armed: this cancel's attempt is done.
	attempt := h.promptAttemptByID(promptID)
	slog.Info("CancelPrompt: cancelling in-flight prompt", "promptId", promptID)
	h.reportLifecycle("info", "Prompt cancel requested", attempt.logFields(map[string]interface{}{
		"promptId": promptID,
	}))
	cancelFn()

	if !startGraceTimer || attempt == nil {
		return
	}

	grace := h.promptCancelGracePeriod()
	if grace <= 0 {
		return
	}

	go h.watchPromptCancelGrace(attempt, grace)
}

// watchPromptCancelGrace is bound to the one attempt a cancel targeted. It is
// disarmed as soon as that attempt reaches a terminal state, so a stale timer
// can never act on the next prompt (the 2026-09 regression where a follow-up
// accepted inside the grace window was force-stopped and its task failed).
func (h *SessionHost) watchPromptCancelGrace(attempt *promptAttempt, grace time.Duration) {
	fired, stop := h.startCancelGraceTimer(grace)
	defer stop()
	select {
	case <-attempt.done:
		return
	case <-h.lifecycleContext().Done():
		return
	case <-fired:
	}
	h.triggerPromptForceStopIfStuck(attempt, fmt.Sprintf("Prompt cancel grace elapsed after %s", grace))
}

func (h *SessionHost) startCancelGraceTimer(d time.Duration) (<-chan time.Time, func()) {
	if h.cancelGraceTimer != nil {
		return h.cancelGraceTimer(d)
	}
	timer := time.NewTimer(d)
	return timer.C, func() { timer.Stop() }
}

// settleStuckPromptCancel handles a requested cancel whose attempt did not
// finish within the grace period. A stop is never a task failure: the attempt
// finishes "cancelled" and the agent process is restarted through the same
// intentional prompt-cancel path the control-plane Stop uses, which returns
// the host to ready for follow-up prompts.
func (h *SessionHost) settleStuckPromptCancel(attempt *promptAttempt, reason string, fields map[string]interface{}) {
	attempt.completeWith(h, "cancelled", context.Canceled, func() {
		h.stopPromptActivityRereport()
		h.broadcastControl(MsgSessionPromptDone, nil)

		h.mu.RLock()
		hasProcess := h.process != nil
		h.mu.RUnlock()
		if !hasProcess {
			// Whoever cleared the process owns the host transition: Stop()
			// marks it stopped, and monitorProcessExit is already restarting it
			// (including when a crash-recovery restart skipped failing this
			// attempt). Starting a second recovery here would race that owner.
			slog.Warn("ACP prompt cancel did not settle; agent restart already in progress", "promptId", attempt.id, "reason", reason)
			h.reportLifecycle("warn", "ACP prompt cancel did not settle; agent restart already in progress", fields)
			return
		}
		slog.Warn("ACP prompt cancel did not settle; restarting agent", "promptId", attempt.id, "reason", reason)
		h.reportLifecycle("warn", "ACP prompt cancel did not settle; restarting agent", fields)
		h.StopProcessForPromptCancel()
	})
}

// ForwardToAgent sends a raw message to the agent's stdin.
func (h *SessionHost) ForwardToAgent(message []byte) {
	h.mu.RLock()
	process := h.process
	h.mu.RUnlock()

	if process == nil {
		slog.Warn("No agent process running, dropping message")
		return
	}

	data := append(message, '\n')
	if _, err := process.Stdin().Write(data); err != nil {
		slog.Error("Failed to write to agent stdin", "error", err)
	}
}

// SignalProcess sends a signal to the agent process. This is used for agents
// that don't implement session/cancel (e.g., opencode) — SIGTERM is sent
// directly to the process instead of forwarding the cancel RPC.
func (h *SessionHost) SignalProcess(sig syscall.Signal) {
	h.mu.RLock()
	process := h.process
	h.mu.RUnlock()

	if process == nil {
		slog.Warn("SignalProcess: no agent process running")
		return
	}

	process.KillContainerProcesses(sig)
	slog.Info("SignalProcess: sent signal to agent process", "signal", sig, "agentType", h.AgentType())
}

// StopProcessForPromptCancel terminates the current agent process for a user
// prompt cancel without marking the host stopped. The process monitor will
// restart the agent and return the host to ready for follow-up prompts.
func (h *SessionHost) StopProcessForPromptCancel() {
	h.mu.Lock()
	process := h.process
	if process != nil {
		h.intentionalPromptCancelProcessStop = true
	}
	h.mu.Unlock()

	if process == nil {
		slog.Warn("StopProcessForPromptCancel: no agent process running")
		return
	}

	if err := process.Stop(); err != nil {
		slog.Warn("StopProcessForPromptCancel: failed to stop agent process", "error", err)
	}
}
