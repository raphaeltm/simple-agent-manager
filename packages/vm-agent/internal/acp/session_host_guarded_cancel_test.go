package acp

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestGuardedCancelNeverCancelsNewerTurn(t *testing.T) {
	h := &SessionHost{}
	firstCtx, firstCancel := context.WithCancel(context.Background())
	defer firstCancel()
	first, ok := h.beginPrompt(firstCancel, nil)
	if !ok {
		t.Fatal("first prompt not admitted")
	}
	h.releasePrompt(first)
	nextCtx, nextCancel := context.WithCancel(context.Background())
	defer nextCancel()
	next, ok := h.beginPrompt(nextCancel, nil)
	if !ok {
		t.Fatal("next prompt not admitted")
	}
	defer h.releasePrompt(next)
	if got := h.CancelPromptGuarded(first.startedAt.UnixMilli()); got != "turn_changed" {
		t.Fatalf("got %s", got)
	}
	if firstCtx.Err() != nil || nextCtx.Err() != nil {
		t.Fatal("stale cancel affected a context")
	}
	// Verify the matched attempt's exact context is cancelled.
	if got := h.CancelPromptGuarded(next.startedAt.UnixMilli()); got != "cancelled" {
		t.Fatalf("got %s", got)
	}
	if nextCtx.Err() != context.Canceled {
		t.Fatal("matching prompt not cancelled")
	}
	close(next.done) // disarm attempt-scoped grace timer
}
func TestGuardedCancelIdleAndInvalidToken(t *testing.T) {
	h := &SessionHost{}
	if got := h.CancelPromptGuarded(1); got != "idle" {
		t.Fatalf("got %s", got)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	attempt, _ := h.beginPrompt(cancel, nil)
	defer h.releasePrompt(attempt)
	if got := h.CancelPromptGuarded(0); got != "turn_changed" {
		t.Fatalf("got %s", got)
	}
	if ctx.Err() != nil {
		t.Fatal("invalid token cancelled prompt")
	}
}
func TestPromptEpochMonotonicWithinOneMillisecond(t *testing.T) {
	h := &SessionHost{}
	first, _ := h.beginPrompt(func() {}, nil)
	// Retained prior epoch far in the future makes wall-clock ties deterministic.
	first.startedAt = time.Now().Add(time.Hour)
	h.releasePrompt(first)
	next, _ := h.beginPrompt(func() {}, nil)
	defer h.releasePrompt(next)
	if next.startedAt.UnixMilli() <= first.startedAt.UnixMilli() {
		t.Fatal("epoch was reused")
	}
}

type guardedBlockingProcess struct {
	agentProcess
	entered chan struct{}
	release chan struct{}
}

func (p *guardedBlockingProcess) Stop() error {
	close(p.entered)
	<-p.release
	return p.agentProcess.Stop()
}

func TestGuardedCancelHoldsAdmissionUntilCapturedProcessStops(t *testing.T) {
	h := newCancelGraceHarness(t) // fake agent ignores session/cancel
	cancelTransports[0].prompt(t, h, "guarded")
	h.agent.nextPrompt(t)
	attempt, ok := h.host.activePromptAttempt()
	if !ok {
		t.Fatal("no active prompt")
	}
	blocking := &guardedBlockingProcess{agentProcess: h.process, entered: make(chan struct{}), release: make(chan struct{})}
	h.host.mu.Lock()
	h.host.process = blocking
	h.host.mu.Unlock()
	result := make(chan string, 1)
	go func() { result <- h.host.CancelPromptGuarded(attempt.startedAt.UnixMilli()) }()
	<-blocking.entered
	// Local SDK completion may release promptInFlight; process stop still gates admission.
	h.nextCompletion(t)
	if _, admitted := h.host.beginPrompt(func() {}, nil); admitted {
		t.Fatal("new prompt admitted before stop completed")
	}
	close(blocking.release)
	if got := <-result; got != "cancelled" {
		t.Fatalf("got %s", got)
	}
	if got := h.process.stopCount.Load(); got != 1 {
		t.Fatalf("ignoring agent process stop count=%d", got)
	}
	next, admitted := h.host.beginPrompt(func() {}, nil)
	if !admitted {
		t.Fatal("admission stayed closed")
	}
	h.host.releasePrompt(next)
}

type guardedFailingProcess struct{ agentProcess }

func (p *guardedFailingProcess) Stop() error { return errors.New("stop deadline") }
func TestGuardedCancelFailureDoesNotPublishIdleOrAdmitWork(t *testing.T) {
	h := newCancelGraceHarness(t)
	cancelTransports[0].prompt(t, h, "guarded-failure")
	h.agent.nextPrompt(t)
	attempt, _ := h.host.activePromptAttempt()
	h.host.mu.Lock()
	h.host.process = &guardedFailingProcess{h.process}
	h.host.mu.Unlock()
	if got := h.host.CancelPromptGuarded(attempt.startedAt.UnixMilli()); got != "unconfirmed" {
		t.Fatalf("got %s", got)
	}
	h.nextCompletion(t)
	if _, ok := h.host.beginPrompt(func() {}, nil); ok {
		t.Fatal("admitted work without termination proof")
	}
	if h.host.Status() == HostReady {
		t.Fatal("published ready without termination proof")
	}
	if got := h.host.CancelPromptGuarded(attempt.startedAt.UnixMilli()); got == "idle" {
		t.Fatal("pending stop reported idle")
	}
}

func TestGuardedCancelLateStopCannotClearNewerCancellation(t *testing.T) {
	h := newCancelGraceHarness(t)
	cancelTransports[0].prompt(t, h, "guarded-old")
	h.agent.nextPrompt(t)
	first, _ := h.host.activePromptAttempt()
	blocking := &guardedBlockingProcess{agentProcess: h.process, entered: make(chan struct{}), release: make(chan struct{})}
	h.host.mu.Lock()
	h.host.process = blocking
	h.host.mu.Unlock()
	result := make(chan string, 1)
	go func() { result <- h.host.CancelPromptGuarded(first.startedAt.UnixMilli()) }()
	<-blocking.entered
	h.nextCompletion(t)
	// Model process-exit proof/recovery beating the delayed Stop return.
	h.host.promptMu.Lock()
	h.host.guardedCancelPending = false
	h.host.guardedCancelAttempt = nil
	h.host.promptMu.Unlock()
	next, ok := h.host.beginPrompt(func() {}, nil)
	if !ok {
		t.Fatal("next prompt not admitted after recovery")
	}
	defer h.host.releasePrompt(next)
	h.host.promptMu.Lock()
	h.host.guardedCancelPending = true
	h.host.guardedCancelAttempt = next
	h.host.promptMu.Unlock()
	close(blocking.release)
	<-result
	h.host.promptMu.Lock()
	pending, owner := h.host.guardedCancelPending, h.host.guardedCancelAttempt
	h.host.promptMu.Unlock()
	if !pending || owner != next {
		t.Fatal("old stop cleared newer cancellation fence")
	}
}
