package acp

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestEvictionDefersAlreadyActiveRecoveryWatchdog(t *testing.T) {
	for _, mode := range []string{"commit", "rollback", "no eviction"} {
		t.Run(mode, func(t *testing.T) {
			host := newRecoveryTestHost(t, 200*time.Millisecond)
			defer host.Stop()
			_, completed, _ := armRecoverablePrompt(t, host, "claude-code", 10*time.Second, false)
			if _, ok := host.beginPrompt(func() {}, nil); !ok {
				t.Fatal("prompt refused")
			}
			finishWithPeerDisconnect(host)
			var rollback func()
			if mode != "no eviction" {
				_, rollback = host.PrepareEviction()
			}
			if mode != "no eviction" {
				select {
				case reason := <-completed:
					t.Fatalf("active recovery watchdog escaped eviction: %s", reason)
				case <-time.After(300 * time.Millisecond):
				}
				waitForParked(t, host, func(p evictionParked) bool { return len(p.promptCrash) == 1 })
			}
			want := fatalErrorStopReason
			if mode == "commit" {
				host.StopForEviction()
				want = EvictedStopReason
			} else if mode == "rollback" {
				rollback()
			}
			expectCompletion(t, completed, want, time.Second, "active recovery watchdog did not resolve")
			assertNoSecondCompletion(t, completed)
		})
	}
}

func TestEvictionReplayKeepsIdleExitAdmissionClosed(t *testing.T) {
	for _, mode := range []string{"rollback", "expiry"} {
		t.Run(mode, func(t *testing.T) {
			host := newRecoveryTestHost(t, time.Second)
			defer host.Stop()
			proc, _, _ := armRecoverablePrompt(t, host, "claude-code", 10*time.Second, false)
			var starts atomic.Int32
			completed := startRecoveryMonitor(t, host, proc, "claude-code", countingSpawn(t, &starts))
			_, rollback := host.PrepareEviction()
			exitFakeProcess(proc)
			waitForParked(t, host, func(p evictionParked) bool { return len(p.processExit) == 1 })
			entered, release := make(chan struct{}), make(chan struct{})
			defer func() {
				select {
				case <-release:
				default:
					close(release)
				}
			}()
			host.promptMu.Lock()
			epoch := host.evictionEpoch
			host.evictionParked.promptCrash = append([]func(){func() { close(entered); <-release }}, host.evictionParked.promptCrash...)
			host.promptMu.Unlock()
			if mode == "rollback" {
				rollback()
			} else {
				host.expireEvictionPark(epoch)
			}
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("idle exit replay did not start")
			}
			if _, ok := host.beginPrompt(func() {}, nil); ok {
				t.Fatal("admitted new prompt before replay detached exited idle agent")
			}
			close(release)
			waitFor(t, 3*time.Second, func() bool {
				host.promptMu.Lock()
				pending := host.evictionReplayPending
				host.promptMu.Unlock()
				return pending == 0 && host.Status() == HostReady
			})
			select {
			case reason := <-completed:
				t.Fatalf("idle exit failed new work: %s", reason)
			default:
			}
			attempt, ok := host.beginPrompt(func() {}, nil)
			if !ok {
				t.Fatal("replayed exit left admission permanently closed")
			}
			attempt.complete(host, "end_turn", nil)
		})
	}
}

func TestEvictionDefersCooperativePromptCancellation(t *testing.T) {
	for _, mode := range []string{"commit", "rollback", "no eviction"} {
		t.Run(mode, func(t *testing.T) {
			h := newCancelGraceHarness(t)
			transport := cancelTransports[1]
			transport.prompt(t, h, "cooperative-cancel")
			h.agent.nextPrompt(t)
			waitFor(t, time.Second, func() bool { return h.host.Status() == HostPrompting })
			var rollback func()
			if mode != "no eviction" {
				_, rollback = h.host.PrepareEviction()
			}
			transport.cancel(h)
			h.timer.awaitArmed(t) // The grace timer never fires: the ACP call cooperates.
			if mode != "no eviction" {
				h.assertNoCompletion(t)
				waitForParked(t, h.host, func(p evictionParked) bool { return len(p.promptCrash) == 1 })
			}
			want := "cancelled"
			if mode == "commit" {
				h.host.StopForEviction()
				want = EvictedStopReason
			} else if mode == "rollback" {
				rollback()
			}
			if got := h.nextCompletion(t); got.stopReason != want {
				t.Fatalf("completion=%+v want %s", got, want)
			}
			h.assertNoCompletion(t)
		})
	}
}

type rpcDecisionReporter struct {
	*lifecycleRecorder
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (r *rpcDecisionReporter) ReportWarn(message, source, workspace string, ctx map[string]interface{}) {
	if message == "ACP Prompt timed out" {
		r.once.Do(func() { close(r.entered); <-r.release })
	}
	r.lifecycleRecorder.ReportWarn(message, source, workspace, ctx)
}

func TestEvictionPrepareOrdersAfterRpcErrorDecision(t *testing.T) {
	host, _, completed, _ := armEvictedPrompt(t)
	defer host.Stop()
	reporter := &rpcDecisionReporter{lifecycleRecorder: &lifecycleRecorder{}, entered: make(chan struct{}), release: make(chan struct{})}
	defer func() {
		select {
		case <-reporter.release:
		default:
			close(reporter.release)
		}
	}()
	host.config.ErrorReporter = reporter
	host.promptMu.Lock()
	attempt := host.promptAttempt
	host.promptMu.Unlock()
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	finished := make(chan struct{})
	go func() {
		host.finishPromptAttemptWithError(attempt, ctx, json.RawMessage(`"req"`), promptStartInfo{}, errors.New("peer disconnected"))
		close(finished)
	}()
	select {
	case <-reporter.entered:
	case <-time.After(time.Second):
		t.Fatal("RPC error did not reach post-fence decision")
	}
	prepared := make(chan struct{})
	go func() { host.PrepareEviction(); close(prepared) }()
	select {
	case <-prepared:
		t.Error("eviction prepared midway through RPC error terminal decision")
	case <-time.After(50 * time.Millisecond):
	}
	close(reporter.release)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("RPC error stranded")
	}
	select {
	case <-prepared:
	case <-time.After(time.Second):
		t.Fatal("eviction preparation stranded")
	}
	expectCompletion(t, completed, fatalErrorStopReason, time.Second, "ordinary RPC deadline lost terminal verdict")
}

func TestDetachedRecoveryWatchdogCannotFailNewRecovery(t *testing.T) {
	host := newRecoveryTestHost(t, 150*time.Millisecond)
	defer host.Stop()
	_, completed, _ := armRecoverablePrompt(t, host, "claude-code", 10*time.Second, false)
	first, ok := host.beginPrompt(func() {}, nil)
	if !ok {
		t.Fatal("first prompt refused")
	}
	finishWithPeerDisconnect(host)
	_, rollback := host.PrepareEviction()
	waitForParked(t, host, func(p evictionParked) bool { return len(p.promptCrash) == 1 })
	entered, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	host.promptMu.Lock()
	host.evictionParked.promptCrash = append([]func(){func() { close(entered); <-release }}, host.evictionParked.promptCrash...)
	host.promptMu.Unlock()
	host.mu.Lock()
	oldEpoch := host.crashRecoveryEpoch
	host.clearCrashRecoveryLocked()
	host.setStatusLocked(HostReady)
	host.mu.Unlock()
	first.complete(host, crashRecoveredStopReason, nil)
	expectCompletion(t, completed, crashRecoveredStopReason, time.Second, "old recovery did not settle")
	rollback()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("old watchdog replay did not detach")
	}
	host.config.RecoveryWatchdogTimeout = time.Hour
	second, ok := host.beginPrompt(func() {}, nil)
	if !ok {
		t.Fatal("second prompt refused")
	}
	finishWithPeerDisconnect(host)
	host.mu.RLock()
	newEpoch := host.crashRecoveryEpoch
	host.mu.RUnlock()
	if newEpoch == oldEpoch {
		t.Fatal("new recovery did not advance watchdog identity")
	}
	close(release)
	select {
	case reason := <-completed:
		t.Fatalf("old watchdog completed new prompt: %s", reason)
	case <-time.After(100 * time.Millisecond):
	}
	host.mu.RLock()
	active := host.crashRecoveryInProgress && host.crashRecoveryEpoch == newEpoch
	host.mu.RUnlock()
	if !active || second.isTerminal() {
		t.Fatal("old watchdog mutated the new recovery")
	}
	second.complete(host, "cancelled", context.Canceled)
}
