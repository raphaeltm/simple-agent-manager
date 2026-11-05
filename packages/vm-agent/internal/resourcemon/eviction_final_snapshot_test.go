package resourcemon

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"
)

type finalSnapshotRecorder struct {
	mu      sync.Mutex
	calls   []string
	results []EvictionResult
}

func (r *finalSnapshotRecorder) add(call string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, call)
}

func (r *finalSnapshotRecorder) snapshot() ([]string, []EvictionResult) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.calls...), append([]EvictionResult(nil), r.results...)
}

func runFinalSnapshotEviction(t *testing.T, firstQuiesced bool, final func(context.Context, EvictionTarget) (EvictionSnapshotOutcome, error)) *finalSnapshotRecorder {
	t.Helper()
	source := newFakePressureSource()
	recorder := &finalSnapshotRecorder{}
	controller := testEvictionController(t, source, func(cfg *EvictionControllerConfig) {
		cfg.SnapshotWorkspace = func(context.Context, EvictionTarget) (EvictionSnapshotOutcome, error) {
			recorder.add("snapshot")
			return EvictionSnapshotOutcome{Quiesced: firstQuiesced}, nil
		}
		cfg.StopContainer = func(context.Context, EvictionTarget) error { recorder.add("stop"); return nil }
		cfg.FinalSnapshotTimeout = 50 * time.Millisecond
		cfg.FinalSnapshot = func(ctx context.Context, target EvictionTarget) (EvictionSnapshotOutcome, error) {
			recorder.add("final")
			return final(ctx, target)
		}
		cfg.MarkWorkspaceEvicted = func(result EvictionResult) bool {
			recorder.mu.Lock()
			recorder.calls = append(recorder.calls, "mark")
			recorder.results = append(recorder.results, result)
			recorder.mu.Unlock()
			return true
		}
		cfg.NotifyEviction = func(context.Context, EvictionResult) error { recorder.add("notify"); return nil }
	})
	if err := controller.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer controller.Close()
	source.events <- oomPressureEvent("workspace-1", "container-1")
	waitForEvictionTest(t, func() bool {
		calls, _ := recorder.snapshot()
		return len(calls) > 0 && calls[len(calls)-1] == "notify"
	}, "eviction did not notify")
	return recorder
}

func TestFinalSnapshotRunsAfterStopAndBeforeEvictionIsRecorded(t *testing.T) {
	recorder := runFinalSnapshotEviction(t, false, func(context.Context, EvictionTarget) (EvictionSnapshotOutcome, error) {
		return EvictionSnapshotOutcome{Quiesced: true}, nil
	})
	calls, results := recorder.snapshot()
	if want := []string{"snapshot", "stop", "final", "mark", "notify"}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %v, want %v", calls, want)
	}
	if !results[0].SnapshotQuiesced || results[0].FinalSnapshotError != nil {
		t.Fatalf("result = %+v, want quiesced final capture", results[0])
	}
}

func TestFinalSnapshotIsSkippedWhenFirstCaptureWasAlreadyQuiesced(t *testing.T) {
	recorder := runFinalSnapshotEviction(t, true, func(context.Context, EvictionTarget) (EvictionSnapshotOutcome, error) {
		t.Error("final capture ran after an already-final capture")
		return EvictionSnapshotOutcome{}, nil
	})
	calls, results := recorder.snapshot()
	if want := []string{"snapshot", "stop", "mark", "notify"}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %v, want %v", calls, want)
	}
	if !results[0].SnapshotQuiesced {
		t.Fatal("quiesced first capture was not reported")
	}
}

// A failed or timed-out final capture keeps the pre-stop capture: the eviction is still
// recorded so the conversation relocates, but nothing claims the final state was saved.
func TestFinalSnapshotFailureStillRecordsEvictionWithoutPreservation(t *testing.T) {
	for name, final := range map[string]func(context.Context, EvictionTarget) (EvictionSnapshotOutcome, error){
		"error": func(context.Context, EvictionTarget) (EvictionSnapshotOutcome, error) {
			return EvictionSnapshotOutcome{Quiesced: true}, errors.New("helper commit failed")
		},
		"timeout": func(ctx context.Context, _ EvictionTarget) (EvictionSnapshotOutcome, error) {
			<-ctx.Done()
			return EvictionSnapshotOutcome{}, ctx.Err()
		},
		"not quiesced": func(context.Context, EvictionTarget) (EvictionSnapshotOutcome, error) {
			return EvictionSnapshotOutcome{Quiesced: false}, nil
		},
	} {
		t.Run(name, func(t *testing.T) {
			recorder := runFinalSnapshotEviction(t, false, final)
			calls, results := recorder.snapshot()
			if want := []string{"snapshot", "stop", "final", "mark", "notify"}; !reflect.DeepEqual(calls, want) {
				t.Fatalf("calls = %v, want %v", calls, want)
			}
			if results[0].SnapshotQuiesced || !results[0].SnapshotCaptured || !results[0].ContainerStopped {
				t.Fatalf("result = %+v", results[0])
			}
		})
	}
}

func TestFinalSnapshotRequiresTimeout(t *testing.T) {
	cfg := EvictionControllerConfig{FinalSnapshot: func(context.Context, EvictionTarget) (EvictionSnapshotOutcome, error) {
		return EvictionSnapshotOutcome{}, nil
	}}
	if err := cfg.Validate(); err == nil {
		t.Fatal("FinalSnapshot without a timeout validated")
	}
}

// A slow final capture must not hold the single pressure loop: a second workspace that
// needs evicting meanwhile is handled before the first one's final capture finishes.
func TestSlowFinalSnapshotDoesNotBlockTheNextEviction(t *testing.T) {
	source := newFakePressureSource()
	release := make(chan struct{})
	var mu sync.Mutex
	var snapshots, notified []string
	controller := testEvictionController(t, source, func(cfg *EvictionControllerConfig) {
		cfg.SnapshotWorkspace = func(_ context.Context, target EvictionTarget) (EvictionSnapshotOutcome, error) {
			mu.Lock()
			snapshots = append(snapshots, target.WorkspaceID)
			mu.Unlock()
			return EvictionSnapshotOutcome{}, nil
		}
		cfg.FinalSnapshotTimeout = time.Minute
		cfg.FinalSnapshot = func(ctx context.Context, target EvictionTarget) (EvictionSnapshotOutcome, error) {
			if target.WorkspaceID == "workspace-1" {
				select {
				case <-release:
				case <-ctx.Done():
					return EvictionSnapshotOutcome{}, ctx.Err()
				}
			}
			return EvictionSnapshotOutcome{Quiesced: true}, nil
		}
		cfg.NotifyEviction = func(_ context.Context, result EvictionResult) error {
			mu.Lock()
			notified = append(notified, result.Target.WorkspaceID)
			mu.Unlock()
			return nil
		}
	})
	if err := controller.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer controller.Close()

	source.events <- oomPressureEvent("workspace-1", "container-1")
	source.events <- oomPressureEvent("workspace-2", "container-2")
	waitForEvictionTest(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(notified) == 1 && notified[0] == "workspace-2"
	}, "second eviction waited for the first one's final capture")
	mu.Lock()
	if !reflect.DeepEqual(snapshots, []string{"workspace-1", "workspace-2"}) {
		t.Fatalf("snapshots = %v", snapshots)
	}
	mu.Unlock()
	close(release)
	waitForEvictionTest(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(notified) == 2
	}, "first eviction never finished after its final capture")
}
