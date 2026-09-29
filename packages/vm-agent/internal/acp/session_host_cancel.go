package acp

import (
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

	slog.Info("CancelPrompt: cancelling in-flight prompt")
	h.reportLifecycle("info", "Prompt cancel requested", nil)
	cancelFn()

	if !startGraceTimer {
		return
	}

	grace := h.promptCancelGracePeriod()
	if grace <= 0 {
		return
	}

	go func(id uint64, wait time.Duration) {
		timer := time.NewTimer(wait)
		defer timer.Stop()
		<-timer.C
		h.triggerPromptForceStopIfStuck(id, fmt.Sprintf("Prompt cancel grace elapsed after %s", wait))
	}(promptID, grace)
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
