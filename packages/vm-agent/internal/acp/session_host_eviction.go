package acp

import (
	"errors"
	"log/slog"
)

// EvictedStopReason completes a prompt whose runtime was taken by a committed eviction.
// It is not a task verdict: the eviction's durable delivery reports the interrupted work
// and the control plane resumes the conversation elsewhere, so the task completion
// callback posts nothing for it.
const EvictedStopReason = "evicted"

var errWorkspaceEvicted = errors.New("workspace evicted due to resource pressure")

// evictionParked holds crash handling deferred because a durable eviction owns the
// runtime. The eviction's own docker stop is what kills the agent, roughly 100ms
// before `docker stop` returns, so the agent's exit is the eviction, not a crash.
// The killer records the reason before acting (PrepareEviction runs before the
// stop) and the observer reads it here, so no restart is attempted and no terminal
// failure is reported. A committed eviction discards the parked work
// (StopForEviction); a rolled-back one replays it, so a genuine crash is never hidden.
type evictionParked struct {
	promptCrash []func()
	processExit []func()
}

func (h *SessionHost) PrepareEviction() (interrupted *bool, rollback func()) {
	// Match CheckpointRollover's lock order. Keep ownership and admission atomic.
	h.mu.RLock()
	defer h.mu.RUnlock()
	h.promptMu.Lock()
	defer h.promptMu.Unlock()
	wasPending := h.evictionPending
	h.evictionPending = true
	rollback = func() {
		h.promptMu.Lock()
		h.evictionPending = wasPending
		var parked evictionParked
		if !h.evictionPending {
			parked, h.evictionParked = h.evictionParked, evictionParked{}
		}
		h.promptMu.Unlock()
		parked.replay()
	}
	work := h.harnessWorkSnapshot()
	active := h.promptInFlight || work.State == harnessWorkActive || work.State == harnessWorkSettling
	if active {
		return &active, rollback
	}
	switch h.status {
	case HostReady, HostIdle:
		return &active, rollback
	default:
		return nil, rollback
	}
}

// replay runs deferred crash handling in its natural order: the prompt's crash path
// begins crash recovery first, so the process-exit handler then restarts with
// LoadSession instead of failing the prompt outright.
func (p evictionParked) replay() {
	if len(p.promptCrash) == 0 && len(p.processExit) == 0 {
		return
	}
	go func() {
		for _, fn := range p.promptCrash {
			fn()
		}
		for _, fn := range p.processExit {
			fn()
		}
	}()
}

// parkPromptCrashForEviction defers a prompt's crash handling while a durable eviction
// owns the runtime. It reports whether the crash was parked.
func (h *SessionHost) parkPromptCrashForEviction(replay func()) bool {
	h.promptMu.Lock()
	parked := h.evictionPending
	if parked {
		h.evictionParked.promptCrash = append(h.evictionParked.promptCrash, replay)
	}
	h.promptMu.Unlock()
	if parked {
		h.reportEvictionOwnedExit("prompt_disconnected")
	}
	return parked
}

// parkProcessExitForEviction defers process-exit handling (restart, rapid-exit and
// active-prompt failure verdicts) while a durable eviction owns the runtime. A replaced
// process or a stopped host is left to the normal handler, which already ignores both.
func (h *SessionHost) parkProcessExitForEviction(process agentProcess, replay func()) bool {
	h.mu.RLock()
	current := h.process == process && h.status != HostStopped
	h.promptMu.Lock()
	parked := current && h.evictionPending
	if parked {
		h.evictionParked.processExit = append(h.evictionParked.processExit, replay)
	}
	h.promptMu.Unlock()
	h.mu.RUnlock()
	if parked {
		h.reportEvictionOwnedExit("process_exited")
	}
	return parked
}

func (h *SessionHost) reportEvictionOwnedExit(signal string) {
	slog.Info("Agent exit owned by workspace eviction; deferring crash handling",
		"sessionId", h.config.SessionID, "workspaceId", h.config.WorkspaceID, "signal", signal)
	h.broadcastAgentStatus(StatusRecovering, h.AgentType(), "")
	h.reportActivity("recovering")
}

// StopForEviction stops the host for a committed eviction. The eviction's durable
// delivery owns the outcome of any in-flight prompt, so the prompt completes with
// EvictedStopReason instead of "cancelled" or a crash failure, and parked crash
// handling is discarded.
func (h *SessionHost) StopForEviction() {
	h.promptMu.Lock()
	attempt := h.promptAttempt
	active := h.promptInFlight
	h.evictionParked = evictionParked{}
	h.promptMu.Unlock()
	if active && attempt != nil {
		attempt.complete(h, EvictedStopReason, errWorkspaceEvicted)
	}
	h.Stop()
}
