package acp

// PrepareEviction captures ownership and closes prompt admission before an
// involuntary runtime stop. Call rollback only if the durable stop intent could
// not be saved; after that point even a failed Docker stop will be retried.
// nil means unknown (e.g. OOM already disconnected the harness), never idle.
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
		h.promptMu.Unlock()
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
