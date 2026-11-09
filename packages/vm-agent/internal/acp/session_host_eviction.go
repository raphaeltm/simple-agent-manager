package acp

import (
	"errors"
	"log/slog"
	"time"
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
	admissionDone func()
	promptCrash   []func()
	processExit   []func()
}

func (h *SessionHost) PrepareEviction() (interrupted *bool, rollback func()) {
	h.evictionDecisionMu.Lock()
	defer h.evictionDecisionMu.Unlock()
	// Match CheckpointRollover's lock order. Keep ownership and admission atomic.
	h.mu.RLock()
	defer h.mu.RUnlock()
	h.promptMu.Lock()
	defer h.promptMu.Unlock()
	wasPending := h.evictionPending
	if !wasPending {
		h.evictionEpoch++
		h.evictionParkExpired = false
	}
	epoch := h.evictionEpoch
	h.evictionPending = true
	rollback = func() {
		h.promptMu.Lock()
		if h.evictionEpoch != epoch || !h.evictionPending {
			h.promptMu.Unlock()
			return
		}
		h.evictionPending = wasPending
		var parked evictionParked
		if !h.evictionPending {
			parked = h.takeEvictionParkedLocked()
			h.fenceEvictionReplayLocked(&parked)
			h.evictionParkExpired = false
		}
		h.promptMu.Unlock()
		if h.Status() == HostStopped {
			if parked.admissionDone != nil {
				parked.admissionDone()
			}
			return
		}
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
		if p.admissionDone != nil {
			defer p.admissionDone()
		}
		for _, fn := range p.promptCrash {
			fn()
		}
		for _, fn := range p.processExit {
			fn()
		}
	}()
}

// parkPromptCrashForEviction defers a prompt's terminal handling (a crash disconnect, or
// a prompt-timeout force-stop) while a durable eviction owns the runtime. It reports
// whether the handling was parked.
func (h *SessionHost) parkPromptCrashForEviction(signal string, replay func(), attempts ...*promptAttempt) bool {
	h.evictionReportMu.Lock()
	defer h.evictionReportMu.Unlock()
	h.mu.RLock()
	h.promptMu.Lock()
	// A late RPC return is consumed after teardown or prompt completion. Falling
	// through would restart crash handling for an attempt that already ended.
	if h.evictionTeardown || h.status == HostStopped || (len(attempts) > 0 && (h.promptAttempt != attempts[0] || (attempts[0] != nil && attempts[0].isTerminal()))) {
		h.promptMu.Unlock()
		h.mu.RUnlock()
		return true
	}
	h.mu.RUnlock()
	parked := h.evictionPending && !h.evictionParkExpired
	if parked {
		h.evictionParked.promptCrash = append(h.evictionParked.promptCrash, replay)
		h.armEvictionParkDeadlineLocked()
	}
	h.promptMu.Unlock()
	if parked {
		h.reportEvictionOwnedExit(signal)
	}
	return parked
}

// parkProcessExitForEviction defers process-exit handling (restart, rapid-exit and
// active-prompt failure verdicts) while a durable eviction owns the runtime. A replaced
// process or a stopped host is left to the normal handler, which already ignores both.
func (h *SessionHost) parkProcessExitForEviction(process agentProcess, replay func()) bool {
	h.evictionReportMu.Lock()
	defer h.evictionReportMu.Unlock()
	h.mu.RLock()
	if h.evictionTeardown || h.status == HostStopped {
		h.mu.RUnlock()
		return true
	}
	current := h.process == process
	h.promptMu.Lock()
	parked := current && h.evictionPending && !h.evictionParkExpired
	if parked {
		h.evictionParked.processExit = append(h.evictionParked.processExit, replay)
		h.armEvictionParkDeadlineLocked()
	}
	h.promptMu.Unlock()
	h.mu.RUnlock()
	if parked {
		h.reportEvictionOwnedExit("process_exited")
	}
	return parked
}

// armEvictionParkDeadlineLocked bounds the parking. A committed eviction resolves a
// parked exit by stopping the host (StopForEviction) once the eviction is recorded. If
// that never happens (the intent was superseded without stopping this host, or the
// record keeps failing), the deadline replays the parked handling as an ordinary crash
// instead of leaving the task in progress forever. The control plane can still resume
// the conversation if the eviction is reported later. Caller holds promptMu.
func (h *SessionHost) armEvictionParkDeadlineLocked() {
	if h.evictionParkTimer != nil {
		return
	}
	timeout := h.config.EvictionParkTimeout
	if timeout <= 0 {
		timeout = DefaultEvictionParkTimeout
	}
	epoch := h.evictionEpoch
	h.evictionParkTimer = time.AfterFunc(timeout, func() { h.expireEvictionPark(epoch) })
}

func (h *SessionHost) expireEvictionPark(epoch uint64) {
	h.promptMu.Lock()
	if h.evictionEpoch != epoch || !h.evictionPending {
		h.promptMu.Unlock()
		return
	}
	h.evictionParkTimer = nil
	h.evictionPending = false // Expired ownership must also reopen prompt admission.
	h.evictionParkExpired = true
	parked := h.evictionParked
	h.fenceEvictionReplayLocked(&parked)
	h.evictionParked = evictionParked{}
	h.promptMu.Unlock()
	if h.Status() == HostStopped {
		if parked.admissionDone != nil {
			parked.admissionDone()
		}
		return
	}
	slog.Error("Eviction did not resolve a parked agent exit before its deadline; applying crash handling",
		"sessionId", h.config.SessionID, "workspaceId", h.config.WorkspaceID,
		"parkedPromptCrashes", len(parked.promptCrash), "parkedProcessExits", len(parked.processExit))
	parked.replay()
}

// Detached exit observers retain admission until they detach or replace the old peer.
// Caller holds promptMu. A counter preserves independently detached replay batches.
func (h *SessionHost) fenceEvictionReplayLocked(parked *evictionParked) {
	if len(parked.processExit) == 0 {
		return
	}
	h.evictionReplayPending++
	parked.admissionDone = func() { h.promptMu.Lock(); h.evictionReplayPending--; h.promptMu.Unlock() }
}

// takeEvictionParkedLocked removes the parked handling and disarms its deadline.
// Caller holds promptMu.
func (h *SessionHost) takeEvictionParkedLocked() evictionParked {
	if h.evictionParkTimer != nil {
		h.evictionParkTimer.Stop()
		h.evictionParkTimer = nil
	}
	parked := h.evictionParked
	h.evictionParked = evictionParked{}
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
	h.evictionReportMu.Lock()
	h.mu.RLock()
	episode := h.checkpointRollover
	h.promptMu.Lock()
	h.evictionTeardown = true
	attempt := h.promptAttempt
	active := h.promptInFlight
	_ = h.takeEvictionParkedLocked()
	h.promptMu.Unlock()
	h.mu.RUnlock()
	if active && attempt != nil {
		if episode != nil && episode.attempt == attempt {
			episode.completeEviction(h)
		} else {
			attempt.completeEviction(h)
		}
	}
	// Publish the eviction terminal owner before exposing teardown to deadlines.
	h.evictionReportMu.Unlock()
	h.Stop()
}
