package acp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

func startCheckpointForEviction(t *testing.T) (*SessionHost, <-chan string, <-chan CheckpointRolloverResult) {
	t.Helper()
	host := newRecoveryTestHost(t, time.Second)
	t.Cleanup(host.Stop)
	completed := make(chan string, 2)
	host.config.OnPromptComplete = func(reason string, _ error) { completed <- reason }
	proc, reader, writer := newFakeAgentProcess(time.Now().Add(-10*time.Second), false)
	serveCheckpointACP(t, reader, writer)
	conn := acpsdk.NewClientSideConnection(&sessionHostClient{host: host}, proc.Stdin(), proc.Stdout())
	_, cancelPrompt := context.WithCancel(context.Background())
	attempt, ok := host.beginPrompt(cancelPrompt, nil)
	if !ok {
		t.Fatal("prompt refused")
	}
	close(attempt.rpcDone)
	host.mu.Lock()
	host.process, host.acpConn, host.status = proc, conn, HostPrompting
	host.agentType, host.sessionID, host.agentSupportsLoadSession = "openai-codex", "same-session", true
	host.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	t.Cleanup(cancel)
	result := make(chan CheckpointRolloverResult, 1)
	go func() { r, _ := host.CheckpointRollover(ctx, time.Millisecond); result <- r }()
	waitFor(t, time.Second, func() bool { return proc.stopCount.Load() > 0 })
	return host, completed, result
}

func TestEvictionArbitratesCheckpointTerminalOwnership(t *testing.T) {
	for _, mode := range []string{"commit before deadline", "commit after deadline", "rollback", "no eviction"} {
		t.Run(mode, func(t *testing.T) {
			host, completed, result := startCheckpointForEviction(t)
			var rollback func()
			if mode != "no eviction" {
				_, rollback = host.PrepareEviction()
			}
			if mode == "commit before deadline" {
				host.StopForEviction()
			} else if mode != "no eviction" {
				// The real checkpoint operation deadline expires while eviction owns it.
				select {
				case reason := <-completed:
					t.Fatalf("checkpoint published %s before eviction resolved", reason)
				case <-time.After(400 * time.Millisecond):
				}
				select {
				case r := <-result:
					t.Fatalf("checkpoint returned before eviction resolved: %+v", r)
				default:
				}
				if mode == "rollback" {
					rollback()
				} else {
					host.StopForEviction()
				}
			}
			want := "fatal_error"
			wantState := "failed"
			if strings.HasPrefix(mode, "commit") {
				want = EvictedStopReason
				wantState = "superseded"
			}
			expectCompletion(t, completed, want, time.Second, "checkpoint prompt terminal callback missing")
			select {
			case r := <-result:
				if r.State != wantState {
					t.Fatalf("checkpoint=%+v want %s", r, wantState)
				}
			case <-time.After(time.Second):
				t.Fatal("checkpoint caller stranded")
			}
			assertNoSecondCompletion(t, completed)
		})
	}
}

func expectViewerTimeout(t *testing.T, viewer *Viewer, want bool, wait time.Duration) {
	t.Helper()
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		select {
		case message := <-viewer.sendCh:
			if strings.Contains(string(message), "Prompt timed out") {
				if !want {
					t.Fatalf("eviction-owned prompt sent terminal timeout: %s", message)
				}
				return
			}
		case <-timer.C:
			if want {
				t.Fatal("viewer terminal timeout missing after ownership released")
			}
			return
		}
	}
}

func TestEvictionDefersViewerTimeoutUntilOwnershipReleased(t *testing.T) {
	for _, mode := range []string{"commit", "rollback", "expiry", "no eviction"} {
		t.Run(mode, func(t *testing.T) {
			host, _, completed, _ := armEvictedPrompt(t)
			viewer := &Viewer{ID: "viewer-1", sendCh: make(chan []byte, 32), done: make(chan struct{})}
			host.viewerMu.Lock()
			host.viewers[viewer.ID] = viewer
			host.viewerMu.Unlock()
			removeViewer := func() { host.viewerMu.Lock(); delete(host.viewers, viewer.ID); host.viewerMu.Unlock() }
			t.Cleanup(func() { removeViewer(); host.Stop() })
			host.promptMu.Lock()
			attempt := host.promptAttempt
			host.promptMu.Unlock()
			var rollback func()
			if mode != "no eviction" {
				_, rollback = host.PrepareEviction()
			}
			if mode == "expiry" {
				host.config.EvictionParkTimeout = 150 * time.Millisecond
			}
			ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
			defer cancel()
			done := make(chan struct{})
			defer close(done)
			host.watchPromptTimeout(attempt, ctx, done, viewer.ID, json.RawMessage(`"req-1"`), time.Second)
			if mode != "no eviction" {
				expectViewerTimeout(t, viewer, false, 50*time.Millisecond)
			}
			if mode == "commit" {
				removeViewer()
				host.StopForEviction()
				expectCompletion(t, completed, EvictedStopReason, time.Second, "eviction did not end prompt")
				expectViewerTimeout(t, viewer, false, 50*time.Millisecond)
			} else {
				if mode == "rollback" {
					rollback()
				}
				expectViewerTimeout(t, viewer, true, time.Second)
				expectCompletion(t, completed, fatalErrorStopReason, time.Second, "released timeout did not end prompt")
			}
			assertNoSecondCompletion(t, completed)
		})
	}
}

func TestCheckpointFailureAfterNaturalCompletionResolvesSuperseded(t *testing.T) {
	host := newRecoveryTestHost(t, time.Second)
	defer host.Stop()
	attempt, ok := host.beginPrompt(func() {}, nil)
	if !ok {
		t.Fatal("prompt refused")
	}
	episode := &checkpointRolloverEpisode{sessionID: "same-session", attempt: attempt, result: make(chan CheckpointRolloverResult, 1)}
	attempt.complete(host, "end_turn", nil)
	resolved := make(chan CheckpointRolloverResult, 1)
	go func() {
		r, _ := host.resolveCheckpointFailure(episode, CheckpointRolloverResult{State: "failed"}, context.DeadlineExceeded, false)
		resolved <- r
	}()
	select {
	case r := <-resolved:
		if r.State != "superseded" {
			t.Fatalf("checkpoint=%+v", r)
		}
	case <-time.After(time.Second):
		t.Fatal("natural completion stranded checkpoint failure caller")
	}
}

func TestStopDuringCheckpointResolvesCallerWithoutFailure(t *testing.T) {
	host, completed, result := startCheckpointForEviction(t)
	host.Stop()
	expectCompletion(t, completed, "cancelled", time.Second, "stopped checkpoint did not cancel prompt")
	select {
	case r := <-result:
		if r.State != "superseded" {
			t.Fatalf("checkpoint=%+v", r)
		}
	case <-time.After(time.Second):
		t.Fatal("stopped checkpoint caller stranded")
	}
}

func TestCheckpointFailureReplayHonorsRenewedEviction(t *testing.T) {
	host, completed, result := startCheckpointForEviction(t)
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
	rollback()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("checkpoint replay never began")
	}
	host.PrepareEviction()
	close(release)
	waitForParked(t, host, func(p evictionParked) bool { return len(p.promptCrash) == 1 })
	select {
	case reason := <-completed:
		t.Fatalf("renewed eviction lost checkpoint verdict: %s", reason)
	case <-time.After(50 * time.Millisecond):
	}
	host.StopForEviction()
	expectCompletion(t, completed, EvictedStopReason, time.Second, "renewed eviction did not own prompt")
	select {
	case r := <-result:
		if r.State != "superseded" {
			t.Fatalf("checkpoint=%+v", r)
		}
	case <-time.After(time.Second):
		t.Fatal("renewed eviction stranded checkpoint caller")
	}
}

func TestCheckpointDeadlineDuringStopTeardownResolvesCaller(t *testing.T) {
	host, completed, result := startCheckpointForEviction(t)
	// Stop has latched teardown but has not reached its HostStopped transition.
	host.evictionReportMu.Lock()
	host.evictionTeardown = true
	host.evictionReportMu.Unlock()
	expectCompletion(t, completed, "cancelled", time.Second, "teardown consumed checkpoint failure without resolving prompt")
	select {
	case r := <-result:
		if r.State != "superseded" {
			t.Fatalf("checkpoint=%+v", r)
		}
	case <-time.After(time.Second):
		t.Fatal("teardown stranded checkpoint caller")
	}
}

func TestCommittedEvictionDoesNotExposeTeardownBeforeOwningCheckpoint(t *testing.T) {
	host, completed, result := startCheckpointForEviction(t)
	host.PrepareEviction()
	host.mu.RLock()
	episode := host.checkpointRollover
	host.mu.RUnlock()
	// Hold the terminal arbiter after StopForEviction latches teardown. A deadline
	// must not observe ordinary-stop teardown until eviction owns this attempt.
	episode.decisionMu.Lock()
	locked := true
	defer func() {
		if locked {
			episode.decisionMu.Unlock()
		}
	}()
	stopped := make(chan struct{})
	go func() { host.StopForEviction(); close(stopped) }()
	waitFor(t, time.Second, func() bool {
		host.promptMu.Lock()
		defer host.promptMu.Unlock()
		return host.evictionTeardown
	})
	observed := make(chan bool, 1)
	go func() { observed <- host.checkpointTeardownStarted() }()
	select {
	case <-observed:
		t.Error("checkpoint observed teardown before eviction claimed terminal ownership")
	case <-time.After(400 * time.Millisecond):
	}
	episode.decisionMu.Unlock()
	locked = false
	expectCompletion(t, completed, EvictedStopReason, time.Second, "committed eviction became an ordinary cancellation")
	select {
	case r := <-result:
		if r.State != "superseded" {
			t.Fatalf("checkpoint=%+v", r)
		}
	case <-time.After(time.Second):
		t.Fatal("checkpoint caller stranded")
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("eviction stop blocked after terminal arbitration")
	}
	assertNoSecondCompletion(t, completed)
}
