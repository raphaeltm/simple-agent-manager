package server

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
)

func TestDrainStandaloneSnapshotNoopWithoutStandaloneConfig(t *testing.T) {
	s := &Server{}
	if err := s.DrainStandaloneSnapshot(context.Background()); err != nil {
		t.Fatalf("DrainStandaloneSnapshot() error = %v", err)
	}
}

func TestDrainStandaloneSnapshotSharesOneConcurrentAttempt(t *testing.T) {
	wantErr := errors.New("checkpoint degraded")
	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	s := &Server{
		drainSnapshotFn: func(context.Context) error {
			if calls.Add(1) == 1 {
				close(started)
			}
			<-release
			return wantErr
		},
	}

	const callers = 8
	errs := make(chan error, callers)
	var wg sync.WaitGroup
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- s.DrainStandaloneSnapshot(context.Background())
		}()
	}
	<-started
	close(release)
	wg.Wait()
	close(errs)

	if got := calls.Load(); got != 1 {
		t.Fatalf("checkpoint calls = %d, want 1", got)
	}
	for err := range errs {
		if !errors.Is(err, wantErr) {
			t.Fatalf("shared error = %v, want %v", err, wantErr)
		}
	}
}
