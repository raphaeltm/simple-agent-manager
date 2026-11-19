package acp

import (
	"context"
	"testing"
	"time"
)

func TestEvictionInterruptedWork(t *testing.T) {
	for _, tc := range []struct {
		name         string
		status       SessionHostStatus
		activePrompt bool
		work         harnessWorkState
		want         *bool
	}{
		{"human owns ready session", HostReady, false, harnessWorkInactive, boolPointer(false)},
		{"unused session", HostIdle, false, harnessWorkInactive, boolPointer(false)},
		{"prompt accepted before status update", HostReady, true, harnessWorkInactive, boolPointer(true)},
		{"generating", HostPrompting, true, harnessWorkInactive, boolPointer(true)},
		{"background work after turn end", HostReady, false, harnessWorkActive, boolPointer(true)},
		{"settling work", HostReady, false, harnessWorkSettling, boolPointer(true)},
		{"runtime already lost", HostError, false, harnessWorkInactive, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewSessionHost(SessionHostConfig{})
			h.setStatus(tc.status, "")
			h.harnessWorkMu.Lock()
			h.harnessWork.State = tc.work
			h.harnessWorkMu.Unlock()
			if tc.activePrompt {
				h.beginPrompt(func() {}, nil)
			}
			got, _ := h.PrepareEviction()
			if (got == nil) != (tc.want == nil) || got != nil && *got != *tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func boolPointer(value bool) *bool { return &value }

func TestEvictionCaptureSurvivesPromptCompletion(t *testing.T) {
	h := NewSessionHost(SessionHostConfig{})
	h.setStatus(HostReady, "")
	attempt, ok := h.beginPrompt(func() {}, nil)
	if !ok {
		t.Fatal("prompt not accepted")
	}
	captured, _ := h.PrepareEviction()
	attempt.complete(h, "cancelled", context.Canceled)
	if captured == nil || !*captured {
		t.Fatal("lost pre-teardown work state")
	}
}

func TestEvictionClosesAdmissionAndRollbackPreservesPriorFence(t *testing.T) {
	h := NewSessionHost(SessionHostConfig{})
	h.setStatus(HostReady, "")
	state, rollback := h.PrepareEviction()
	if state == nil || *state {
		t.Fatal("expected idle capture")
	}
	if _, ok := h.beginPrompt(func() {}, nil); ok {
		t.Fatal("accepted prompt after idle capture")
	}
	_, rollbackDuplicate := h.PrepareEviction()
	rollbackDuplicate()
	if _, ok := h.beginPrompt(func() {}, nil); ok {
		t.Fatal("retry removed prior eviction fence")
	}
	rollback()
	if _, ok := h.beginPrompt(func() {}, nil); !ok {
		t.Fatal("failed intent left admission fenced")
	}
}

func TestEvictionCaptureConcurrentCheckpoint(t *testing.T) {
	h := NewSessionHost(SessionHostConfig{})
	h.setStatus(HostReady, "")
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 1000; i++ {
			_, rollback := h.PrepareEviction()
			rollback()
		}
	}()
	checkpointDone := make(chan struct{})
	go func() {
		defer close(checkpointDone)
		for i := 0; i < 1000; i++ {
			_, _ = h.CheckpointRollover(context.Background(), time.Millisecond)
		}
	}()
	for _, ch := range []chan struct{}{done, checkpointDone} {
		select {
		case <-ch:
		case <-time.After(5 * time.Second):
			t.Fatal("eviction/checkpoint lock inversion")
		}
	}
}
