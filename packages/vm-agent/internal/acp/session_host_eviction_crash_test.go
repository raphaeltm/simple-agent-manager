package acp

// Production 2026-11-08: an eviction's `docker stop` kills the docker-exec'd agent about
// 100ms before the stop returns. The session host saw an ordinary crash, retried the
// restart one second later, found no container, and reported a terminal `fatal_error`
// task failure for all 14 evicted sessions. These tests drive that disconnect after the
// eviction's real PrepareEviction fence, in both arrival orders, and require that the
// host defers to the eviction instead of issuing a verdict.

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"
)

// evictionCrashWindow outlasts monitorProcessExit's 100ms settle and 1s restart delay,
// so a restart or verdict that the fence failed to stop has time to happen.
const evictionCrashWindow = 1500 * time.Millisecond

func exitFakeProcess(p *fakeAgentProcess) {
	select {
	case <-p.waitCh:
	default:
		close(p.waitCh)
	}
}

func armEvictedPrompt(t *testing.T) (*SessionHost, *fakeAgentProcess, chan string, *atomic.Int32) {
	t.Helper()
	host := newRecoveryTestHost(t, 30*time.Second)
	oldProc, _, _ := armRecoverablePrompt(t, host, "claude-code", 10*time.Second, false)
	if _, ok := host.beginPrompt(func() {}, nil); !ok {
		t.Fatal("prompt not accepted")
	}
	var starts atomic.Int32
	completed := startRecoveryMonitor(t, host, oldProc, "claude-code", countingSpawn(t, &starts))
	return host, oldProc, completed, &starts
}

func assertNoVerdict(t *testing.T, completed <-chan string, starts *atomic.Int32, during string) {
	t.Helper()
	select {
	case reason := <-completed:
		t.Fatalf("%s: eviction-owned exit produced prompt verdict %q", during, reason)
	case <-time.After(evictionCrashWindow):
	}
	if n := starts.Load(); n != 0 {
		t.Fatalf("%s: restart attempted %d time(s) for an eviction-owned exit", during, n)
	}
}

func TestEvictionOwnedDisconnectIsNotACrash(t *testing.T) {
	for _, order := range []string{"prompt error first", "process exit first"} {
		t.Run(order, func(t *testing.T) {
			host, oldProc, completed, starts := armEvictedPrompt(t)
			interrupted, _ := host.PrepareEviction()
			if interrupted == nil || !*interrupted {
				t.Fatal("eviction did not capture the in-flight prompt as interrupted work")
			}
			if order == "prompt error first" {
				finishWithPeerDisconnect(host)
				exitFakeProcess(oldProc)
			} else {
				exitFakeProcess(oldProc)
				waitForParked(t, host, func(p evictionParked) bool { return len(p.processExit) == 1 })
				finishWithPeerDisconnect(host)
			}
			assertNoVerdict(t, completed, starts, "before commit")

			// The committed eviction ends the prompt with its own reason, exactly once.
			host.StopForEviction()
			expectCompletion(t, completed, EvictedStopReason, time.Second, "committed eviction did not end the prompt")
			assertNoSecondCompletion(t, completed)
			if host.Status() != HostStopped {
				t.Fatalf("status = %s, want stopped", host.Status())
			}
		})
	}
}

func TestEvictionOwnedIdleExitDoesNotRestart(t *testing.T) {
	host := newRecoveryTestHost(t, 30*time.Second)
	oldProc, _, _ := armRecoverablePrompt(t, host, "claude-code", 10*time.Second, false)
	var starts atomic.Int32
	completed := startRecoveryMonitor(t, host, oldProc, "claude-code", countingSpawn(t, &starts))
	if interrupted, _ := host.PrepareEviction(); interrupted == nil || *interrupted {
		t.Fatal("idle host should be captured as not interrupted")
	}
	exitFakeProcess(oldProc)
	waitForParked(t, host, func(p evictionParked) bool { return len(p.processExit) == 1 })
	assertNoVerdict(t, completed, &starts, "idle exit")
	host.StopForEviction()
	assertNoSecondCompletion(t, completed)
	if host.Status() != HostStopped {
		t.Fatalf("status = %s, want stopped", host.Status())
	}
}

// The prompt can see the disconnect while the process has not exited yet (a broken
// stdio pipe). The prompt path alone must not start crash recovery: that would stop the
// process and arm the recovery watchdog, whose expiry is itself a fatal verdict.
func TestEvictionOwnedPromptDisconnectAloneStartsNoRecovery(t *testing.T) {
	host, oldProc, completed, starts := armEvictedPrompt(t)
	host.PrepareEviction()
	finishWithPeerDisconnect(host)
	assertNoVerdict(t, completed, starts, "prompt disconnect")
	if n := oldProc.stopCount.Load(); n != 0 {
		t.Fatalf("crash recovery stopped the agent %d time(s) during an eviction", n)
	}
	host.mu.RLock()
	recovering := host.crashRecoverySnapshotLocked().inProgress
	host.mu.RUnlock()
	if recovering {
		t.Fatal("crash recovery (and its watchdog) started for an eviction-owned disconnect")
	}
	waitForParked(t, host, func(p evictionParked) bool { return len(p.promptCrash) == 1 })
	host.StopForEviction()
	expectCompletion(t, completed, EvictedStopReason, time.Second, "committed eviction did not end the prompt")
}

// An eviction that never resolves its parked exit (its record keeps failing, or the
// intent was superseded without stopping this host) must not leave the task in progress
// forever: after the deadline the host applies ordinary crash handling.
func TestUnresolvedEvictionParkFallsBackToCrashHandling(t *testing.T) {
	host := newRecoveryTestHost(t, 30*time.Second)
	defer host.Stop()
	host.config.EvictionParkTimeout = 300 * time.Millisecond
	oldProc, _, _ := armRecoverablePrompt(t, host, "claude-code", 10*time.Second, false)
	if _, ok := host.beginPrompt(func() {}, nil); !ok {
		t.Fatal("prompt not accepted")
	}
	completed := startRecoveryMonitor(t, host, oldProc, "claude-code", func(*agentStartup) (agentProcess, error) {
		return nil, errNoRunningDevcontainerForTest
	})
	host.PrepareEviction()
	finishWithPeerDisconnect(host)
	exitFakeProcess(oldProc)
	select {
	case reason := <-completed:
		t.Fatalf("verdict %q before the park deadline", reason)
	case <-time.After(200 * time.Millisecond):
	}
	expectCompletion(t, completed, fatalErrorStopReason, 5*time.Second, "parked exit was never resolved after its deadline")
	assertNoSecondCompletion(t, completed)
}

func waitForParked(t *testing.T, host *SessionHost, done func(evictionParked) bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		host.promptMu.Lock()
		ok := done(host.evictionParked)
		host.promptMu.Unlock()
		if ok {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("exit was not parked by the eviction fence")
}

// A rolled-back eviction (its intent was never committed, so no docker stop ran) must
// not hide a real crash: the parked handling replays as LoadSession crash recovery.
func TestRolledBackEvictionReplaysCrashRecovery(t *testing.T) {
	host, oldProc, completed, starts := armEvictedPrompt(t)
	defer host.Stop()
	_, rollback := host.PrepareEviction()
	finishWithPeerDisconnect(host)
	exitFakeProcess(oldProc)
	assertNoVerdict(t, completed, starts, "before rollback")

	rollback()
	expectCompletion(t, completed, crashRecoveredStopReason, 3*time.Second, "rollback did not replay crash recovery")
	assertNoSecondCompletion(t, completed)
	if n := starts.Load(); n != 1 {
		t.Fatalf("restart count after rollback = %d, want 1", n)
	}
}

// A nested PrepareEviction rollback (a retried intent) must keep the outer fence and
// keep the parked handling parked.
func TestNestedEvictionRollbackKeepsCrashParked(t *testing.T) {
	host, oldProc, completed, starts := armEvictedPrompt(t)
	defer host.Stop()
	_, outer := host.PrepareEviction()
	finishWithPeerDisconnect(host)
	exitFakeProcess(oldProc)
	_, inner := host.PrepareEviction()
	inner()
	assertNoVerdict(t, completed, starts, "after nested rollback")
	outer()
	expectCompletion(t, completed, crashRecoveredStopReason, 3*time.Second, "outer rollback did not replay")
}

// Control: without an eviction the same container-gone restart failure is still a
// terminal verdict, so the fence (not a changed crash path) is what suppresses it.
func TestCrashWithoutEvictionStillFailsWhenRestartFails(t *testing.T) {
	host := newRecoveryTestHost(t, 30*time.Second)
	defer host.Stop()
	oldProc, _, _ := armRecoverablePrompt(t, host, "claude-code", 10*time.Second, false)
	if _, ok := host.beginPrompt(func() {}, nil); !ok {
		t.Fatal("prompt not accepted")
	}
	completed := startRecoveryMonitor(t, host, oldProc, "claude-code", func(*agentStartup) (agentProcess, error) {
		return nil, errNoRunningDevcontainerForTest
	})
	finishWithPeerDisconnect(host)
	exitFakeProcess(oldProc)
	expectCompletion(t, completed, fatalErrorStopReason, 3*time.Second, "unfenced container loss lost its verdict")
}

var errNoRunningDevcontainerForTest = &testError{"failed to discover devcontainer: no running devcontainer found"}

type testError struct{ msg string }

func (e *testError) Error() string { return e.msg }

// Unmanaged sessions arm a prompt deadline (ACP_PROMPT_TIMEOUT) whose expiry force-stops
// the prompt with fatal_error. Landing during an eviction, it must defer like a crash.
func TestPromptDeadlineDuringEvictionIsNotAVerdict(t *testing.T) {
	host, _, completed, starts := armEvictedPrompt(t)
	host.promptMu.Lock()
	attempt := host.promptAttempt
	host.promptMu.Unlock()
	host.PrepareEviction()
	promptCtx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	done := make(chan struct{})
	defer close(done)
	go host.watchPromptTimeout(attempt, promptCtx, done, "viewer-1", json.RawMessage(`"req-1"`), 50*time.Millisecond)
	assertNoVerdict(t, completed, starts, "prompt deadline")
	waitForParked(t, host, func(p evictionParked) bool { return len(p.promptCrash) == 1 })
	host.StopForEviction()
	expectCompletion(t, completed, EvictedStopReason, time.Second, "committed eviction did not end the prompt")
}

// The ACP call itself also returns when its context deadline expires; fencing
// just the timeout watchdog leaves this parallel terminal path unprotected.
func TestPromptDeadlineReturnDuringEvictionIsNotAVerdict(t *testing.T) {
	host, _, completed, starts := armEvictedPrompt(t)
	host.promptMu.Lock()
	attempt := host.promptAttempt
	host.promptMu.Unlock()
	host.PrepareEviction()
	promptCtx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	host.finishPromptAttemptWithError(attempt, promptCtx, json.RawMessage(`"req-1"`), promptStartInfo{startedAt: time.Now(), timeout: time.Second}, context.DeadlineExceeded)
	assertNoVerdict(t, completed, starts, "ACP deadline return")
	waitForParked(t, host, func(p evictionParked) bool { return len(p.promptCrash) == 1 })
	host.StopForEviction()
	expectCompletion(t, completed, EvictedStopReason, time.Second, "committed eviction did not end the prompt")
	assertNoSecondCompletion(t, completed)
}

func TestExpiredEvictionReopensAdmissionAndNextEpisodeParks(t *testing.T) {
	host, oldProc, completed, starts := armEvictedPrompt(t)
	defer host.Stop()
	host.config.EvictionParkTimeout = 500 * time.Millisecond
	_, staleRollback := host.PrepareEviction()
	host.promptMu.Lock()
	oldEpoch := host.evictionEpoch
	host.promptMu.Unlock()
	finishWithPeerDisconnect(host)
	exitFakeProcess(oldProc)
	waitForParked(t, host, func(p evictionParked) bool { return len(p.promptCrash) == 1 && len(p.processExit) == 1 })
	expectCompletion(t, completed, crashRecoveredStopReason, 5*time.Second, "expired eviction did not recover")
	if starts.Load() != 1 {
		t.Fatalf("restarts = %d, want 1", starts.Load())
	}
	attempt, ok := host.beginPrompt(func() {}, nil)
	if !ok {
		t.Fatal("expired eviction permanently fenced the recovered host")
	}
	attempt.complete(host, "cancelled", context.Canceled)

	host.config.EvictionParkTimeout = time.Hour
	_, rollback := host.PrepareEviction()
	staleRollback()
	host.expireEvictionPark(oldEpoch)
	if _, ok := host.beginPrompt(func() {}, nil); ok {
		t.Fatal("old episode cleared the new eviction fence")
	}
	replayed := make(chan struct{}, 1)
	if !host.parkPromptCrashForEviction("next_episode", func() { replayed <- struct{}{} }) {
		t.Fatal("new eviction inherited expired parking state")
	}
	rollback()
	select {
	case <-replayed:
	case <-time.After(time.Second):
		t.Fatal("new episode rollback did not replay")
	}
	if _, ok := host.beginPrompt(func() {}, nil); !ok {
		t.Fatal("new episode rollback left admission fenced")
	}
}
