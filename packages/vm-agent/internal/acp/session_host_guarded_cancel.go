package acp

// CancelPromptGuarded targets the immutable prompt start epoch advertised in
// activity reports. Admission stays closed until the captured process stops.
func (h *SessionHost) CancelPromptGuarded(expectedStartedAt int64) string {
	// Lifecycle lock order matches checkpoint/eviction/process-exit paths.
	h.mu.Lock()
	h.promptMu.Lock()
	attempt := h.promptAttempt
	if h.guardedCancelPending {
		h.promptMu.Unlock()
		h.mu.Unlock()
		return "turn_changed"
	}
	if !h.promptInFlight || attempt == nil {
		h.promptMu.Unlock()
		h.mu.Unlock()
		return "idle"
	}
	if expectedStartedAt <= 0 || attempt.startedAt.UnixMilli() != expectedStartedAt {
		h.promptMu.Unlock()
		h.mu.Unlock()
		return "turn_changed"
	}
	h.promptCancelMu.Lock()
	if h.activePromptID != attempt.id || h.promptCancel == nil {
		h.promptCancelMu.Unlock()
		h.promptMu.Unlock()
		h.mu.Unlock()
		return "turn_changed"
	}
	h.promptCancelRequested = true
	h.guardedCancelPending = true
	h.guardedCancelAttempt = attempt
	attempt.guardedCancel.Store(true)
	cancel, process := h.promptCancel, h.process
	if process != nil {
		h.intentionalPromptCancelProcessStop = true
	}
	h.promptCancelMu.Unlock()
	h.promptMu.Unlock()
	h.mu.Unlock()
	cancel() // captured context, never a later turn's context
	// SDK context cancellation alone may finish locally while a remote harness
	// ignores session/cancel. Stop only the captured process outside all locks.
	if process != nil {
		if err := process.Stop(); err != nil {
			// Retain the admission fence until process-exit proof or host replacement.
			h.mu.Lock()
			h.promptMu.Lock()
			if h.guardedCancelAttempt == attempt && h.process == process {
				h.statusErr = "Guarded cancellation could not confirm process termination"
				h.setStatusLocked(HostError)
			}
			h.promptMu.Unlock()
			h.mu.Unlock()
			return "unconfirmed"
		}
	}
	h.promptMu.Lock()
	if h.guardedCancelAttempt == attempt {
		h.guardedCancelPending = false
		h.guardedCancelAttempt = nil
	}
	h.promptMu.Unlock()
	return "cancelled"
}
