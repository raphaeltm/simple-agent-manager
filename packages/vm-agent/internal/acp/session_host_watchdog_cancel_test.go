package acp

import (
	"sync/atomic"
	"testing"
	"time"
)

// A completed cancellation does not prove the process exited. Drive the real
// cancel-grace timer while Wait remains blocked, then let the recovery watchdog
// arbitrate cleanup independently of the already-terminal prompt verdict.
func TestRecoveryWatchdogAfterCancelGraceWithLiveProcess(t *testing.T) {
	for _, mode := range []string{"unfenced", "commit", "rollback", "expiry"} {
		t.Run(mode, func(t *testing.T) {
			host := newRecoveryTestHost(t, 300*time.Millisecond)
			defer host.Stop()
			proc, _, _ := armRecoverablePrompt(t, host, "claude-code", 10*time.Second, false)
			defer exitFakeProcess(proc)
			var starts atomic.Int32
			completed := startRecoveryMonitor(t, host, proc, "claude-code", countingSpawn(t, &starts))
			timer := &gatedGraceTimer{armed: make(chan chan time.Time, 1)}
			host.cancelGraceTimer = timer.start
			attempt, ok := host.beginPrompt(func() {}, nil)
			if !ok {
				t.Fatal("prompt refused")
			}
			finishWithPeerDisconnect(host)
			host.CancelPrompt()
			timer.awaitArmed(t) <- time.Now()
			expectCompletion(t, completed, "cancelled", time.Second, "cancel grace did not settle prompt")
			if !attempt.isTerminal() {
				t.Fatal("cancelled attempt is not terminal")
			}
			select {
			case <-proc.waitCh:
				t.Fatal("original process unexpectedly exited")
			default:
			}
			waitFor(t, time.Second, func() bool { return proc.stopCount.Load() >= 2 })
			var rollback func()
			if mode != "unfenced" {
				_, rollback = host.PrepareEviction()
				waitForParked(t, host, func(p evictionParked) bool { return len(p.promptCrash) == 1 })
				host.mu.RLock()
				active := host.crashRecoveryInProgress && host.sessionID != ""
				host.mu.RUnlock()
				if !active {
					t.Fatal("watchdog cleared recovery through eviction fence")
				}
				switch mode {
				case "commit":
					host.StopForEviction()
				case "rollback":
					rollback()
				case "expiry":
					host.promptMu.Lock()
					epoch := host.evictionEpoch
					host.promptMu.Unlock()
					host.expireEvictionPark(epoch)
				}
			}
			if mode == "commit" {
				if host.Status() != HostStopped {
					t.Fatal("eviction commit did not stop host")
				}
			} else {
				waitFor(t, time.Second, func() bool {
					host.mu.RLock()
					defer host.mu.RUnlock()
					return !host.crashRecoveryInProgress && host.status == HostError && host.sessionID == ""
				})
				waitFor(t, time.Second, func() bool { return proc.stopCount.Load() >= 3 })
			}
			if starts.Load() != 0 {
				t.Fatal("blocked old process unexpectedly restarted")
			}
			assertNoSecondCompletion(t, completed)
		})
	}
}

// Even within the same recovery epoch, a watchdog captured for an older prompt
// must not clear a newer attempt. Omitting the attempt guard must fail this test.
func TestRecoveryWatchdogDoesNotTouchNewerAttemptInSameEpoch(t *testing.T) {
	host := newRecoveryTestHost(t, time.Hour)
	defer host.Stop()
	_, completed, _ := armRecoverablePrompt(t, host, "claude-code", 10*time.Second, false)
	first, ok := host.beginPrompt(func() {}, nil)
	if !ok {
		t.Fatal("first prompt refused")
	}
	finishWithPeerDisconnect(host)
	host.mu.RLock()
	epoch := host.crashRecoveryEpoch
	host.mu.RUnlock()
	first.complete(host, "cancelled", nil)
	expectCompletion(t, completed, "cancelled", time.Second, "first prompt did not settle")
	second, ok := host.beginPrompt(func() {}, nil)
	if !ok {
		t.Fatal("second prompt refused")
	}
	host.finishCrashRecoveryTimeout(time.Second, nil, epoch, first)
	host.mu.RLock()
	active := host.crashRecoveryInProgress
	host.mu.RUnlock()
	if !active || second.isTerminal() {
		t.Fatal("old watchdog mutated newer prompt")
	}
	second.complete(host, "cancelled", nil)
}
