package acp

import (
	"context"
	"testing"
	"time"
)

// These tests use the existing in-memory fake process, never an OS subprocess.
func secretWorkTestHost(t *testing.T) *SessionHost {
	t.Helper()
	host := NewSessionHost(SessionHostConfig{})
	process, _, _ := newFakeAgentProcess(time.Now(), true)
	host.mu.Lock()
	host.process = process
	host.setStatusLocked(HostReady)
	host.mu.Unlock()
	t.Cleanup(host.Stop)
	return host
}
func TestSecretWorkOutlivesPromptTurnAndPreventsIdleSuspend(t *testing.T) {
	host := secretWorkTestHost(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if !host.TrackSecretExecution("synthetic-job", time.Now().Add(time.Second), cancel) {
		t.Fatal("job not tracked")
	}
	host.markPromptDone()
	snapshot := host.harnessWorkSnapshot()
	if snapshot.State != harnessWorkActive || snapshot.Count != 1 || snapshot.Source != secretExecutionWorkSource || !host.isPromptingOrRecovering() {
		t.Fatal("accepted job lost its activity lease")
	}
	host.EndSecretExecution("synthetic-job")
	if host.hasSecretExecutionWork() || host.isPromptingOrRecovering() {
		t.Fatal("finished job kept session busy")
	}
	if ctx.Err() != nil {
		t.Fatal("finishing activity accounting unexpectedly cancelled caller")
	}
}
func TestSecretWorkStopAndSuspendCancelOwnedJobs(t *testing.T) {
	for _, operation := range []string{"stop", "suspend"} {
		t.Run(operation, func(t *testing.T) {
			host := secretWorkTestHost(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if !host.TrackSecretExecution("synthetic-job", time.Now().Add(time.Second), cancel) {
				t.Fatal("job not tracked")
			}
			if operation == "stop" {
				host.Stop()
			} else {
				host.Suspend()
			}
			if ctx.Err() != context.Canceled || host.hasSecretExecutionWork() {
				t.Fatal("owned job not cancelled/cleared")
			}
			if host.TrackSecretExecution("must-not-wake", time.Now().Add(time.Second), cancel) {
				t.Fatal("stopped host accepted job")
			}
		})
	}
}
func TestExpiredSecretWorkCannotRenewLease(t *testing.T) {
	host := secretWorkTestHost(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if !host.TrackSecretExecution("expired", time.Now().Add(-time.Second), cancel) {
		t.Fatal("fixture not tracked")
	}
	if host.hasSecretExecutionWork() || ctx.Err() != context.Canceled {
		t.Fatal("expired job renewed activity")
	}
}
