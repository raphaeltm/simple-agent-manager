package acp

// Production 2026-11-08: an eviction's `docker stop` kills the docker-exec'd agent about
// 100ms before the stop returns. The session host saw an ordinary crash, retried the
// restart one second later, found no container, and reported a terminal `fatal_error`
// task failure for all 14 evicted sessions. These tests drive that disconnect after the
// eviction's real PrepareEviction fence, in both arrival orders, and require that the
// host defers to the eviction instead of issuing a verdict.

import (
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
				time.Sleep(200 * time.Millisecond)
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
	assertNoVerdict(t, completed, &starts, "idle exit")
	host.StopForEviction()
	assertNoSecondCompletion(t, completed)
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
