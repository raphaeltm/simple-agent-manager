package acp

import (
	"context"
	"sync"
	"sync/atomic"
	"time"
)

// PromptTerminalObserver receives the terminal state of one accepted prompt.
// It is used by the VM HTTP delivery protocol to durably complete a receipt.
// Implementations must return quickly; notification runs asynchronously.
type PromptTerminalObserver func(stopReason string, promptErr error)

type promptAttempt struct {
	id                  uint64
	startedAt           time.Time
	cancel              context.CancelFunc
	done                chan struct{}
	rpcDone             chan struct{}
	terminalMu          sync.Mutex
	terminal            bool
	checkpointOwned     bool
	observer            PromptTerminalObserver
	checkpointRequested atomic.Bool
}

type checkpointRolloverEpisode struct {
	sessionID    string
	attempt      *promptAttempt
	result       chan CheckpointRolloverResult
	operationCtx context.Context
	forced       bool
	decisionMu   sync.Mutex
	outcome      sync.Once
	terminal     atomic.Bool
	finalResult  CheckpointRolloverResult
}

// complete is the checkpoint episode's linearization point. A terminal caller
// that wins permanently suppresses process-exit restart for this episode; a
// successful strict resume that wins cannot be overturned by a later deadline.
func (e *checkpointRolloverEpisode) complete(result CheckpointRolloverResult, terminal bool) bool {
	e.decisionMu.Lock()
	defer e.decisionMu.Unlock()
	return e.completeLocked(result, terminal)
}

func (e *checkpointRolloverEpisode) completeLocked(result CheckpointRolloverResult, terminal bool) bool {
	won := false
	e.outcome.Do(func() {
		won = true
		e.finalResult = result
		if terminal {
			e.terminal.Store(true)
		}
		e.result <- result
	})
	return won
}

// completeStrictResume atomically orders the checkpoint outcome after the
// prompt attempt's terminal arbiter. Natural completion or user cancellation
// therefore wins as superseded; an already-terminal episode can never publish
// a later successful resume.
func (e *checkpointRolloverEpisode) completeStrictResume(h *SessionHost, result CheckpointRolloverResult) (CheckpointRolloverResult, bool) {
	e.decisionMu.Lock()
	defer e.decisionMu.Unlock()
	if e.terminal.Load() {
		return e.finalResult, false
	}
	if !e.attempt.completeCheckpoint(h, checkpointPreemptedStopReason, nil) {
		superseded := CheckpointRolloverResult{State: "superseded", ACPSessionID: e.sessionID}
		e.completeLocked(superseded, true)
		return superseded, false
	}
	e.completeLocked(result, false)
	return result, true
}

func (a *promptAttempt) complete(h *SessionHost, stopReason string, promptErr error) bool {
	return a.completeWith(h, stopReason, promptErr, nil)
}

func (a *promptAttempt) completeWith(h *SessionHost, stopReason string, promptErr error, finalize func()) bool {
	a.terminalMu.Lock()
	if a.terminal || a.checkpointOwned {
		a.terminalMu.Unlock()
		return false
	}
	a.terminal = true
	a.terminalMu.Unlock()
	a.publishCompletion(h, stopReason, promptErr, finalize)
	return true
}

func (a *promptAttempt) claimCheckpointTerminal() bool {
	a.terminalMu.Lock()
	defer a.terminalMu.Unlock()
	if a.terminal || a.checkpointOwned {
		return false
	}
	a.checkpointOwned = true
	return true
}

func (a *promptAttempt) completeCheckpoint(h *SessionHost, stopReason string, promptErr error) bool {
	a.terminalMu.Lock()
	if a.terminal || !a.checkpointOwned {
		a.terminalMu.Unlock()
		return false
	}
	a.checkpointOwned = false
	a.terminal = true
	a.terminalMu.Unlock()
	a.publishCompletion(h, stopReason, promptErr, nil)
	return true
}

func (a *promptAttempt) publishCompletion(h *SessionHost, stopReason string, promptErr error, finalize func()) {
	// Release the admission gate before publishing the terminal status. The
	// public AcceptPrompt path also requires HostReady, so the intermediate
	// prompting/starting/error status cannot admit a new prompt.
	h.releasePrompt(a)
	if finalize != nil {
		finalize()
	}
	close(a.done)
	if cb := h.config.OnPromptComplete; cb != nil {
		go cb(stopReason, promptErr)
	}
	if a.observer != nil {
		go a.observer(stopReason, promptErr)
	}
}
