package resourcemon

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakePressureSource struct {
	events chan PressureEvent
	mu     sync.RWMutex
	state  ResourcePressure
}

func newFakePressureSource() *fakePressureSource {
	return &fakePressureSource{events: make(chan PressureEvent, 16)}
}

func (f *fakePressureSource) PressureEvents() <-chan PressureEvent {
	return f.events
}

func (f *fakePressureSource) CurrentPressure() ResourcePressure {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return cloneResourcePressure(f.state)
}

func (f *fakePressureSource) setPressure(state ResourcePressure) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.state = state
}

func testEvictionController(
	t *testing.T,
	source *fakePressureSource,
	mutate func(*EvictionControllerConfig),
) *EvictionController {
	t.Helper()
	cfg := EvictionControllerConfig{
		Source:          source,
		DebounceWindow:  time.Minute,
		SnapshotTimeout: time.Second,
		ResolveTimeout:  time.Second,
		ResolveWorkspace: func(_ context.Context, metric ContainerMetric) (WorkspaceContainer, bool) {
			return WorkspaceContainer{
				WorkspaceID:   "workspace-" + strings.TrimPrefix(metric.ID, "container-"),
				ContainerID:   metric.ID,
				ContainerName: metric.Name,
			}, true
		},
		SnapshotWorkspace: func(context.Context, EvictionTarget) error { return nil },
		StopContainer:     func(context.Context, EvictionTarget) error { return nil },
		MarkWorkspaceEvicted: func(EvictionResult) bool {
			return true
		},
		NotifyEviction: func(context.Context, EvictionResult) error { return nil },
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	if mutate != nil {
		mutate(&cfg)
	}
	controller, err := NewEvictionController(cfg)
	if err != nil {
		t.Fatalf("NewEvictionController: %v", err)
	}
	return controller
}

func waitForEvictionTest(t *testing.T, condition func() bool, message string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal(message)
}

func oomPressureEvent(workspaceID, containerID string) PressureEvent {
	return PressureEvent{
		Type:        PressureEventContainerOOM,
		Level:       PressureLevelCritical,
		WorkspaceID: workspaceID,
		ContainerID: containerID,
		OccurredAt:  time.Now().UTC(),
	}
}

func TestEvictionControllerSnapshotsBeforeStoppingContainerFromPressureEvents(t *testing.T) {
	source := newFakePressureSource()
	var mu sync.Mutex
	var calls []string

	controller := testEvictionController(t, source, func(cfg *EvictionControllerConfig) {
		cfg.SnapshotWorkspace = func(context.Context, EvictionTarget) error {
			mu.Lock()
			defer mu.Unlock()
			calls = append(calls, "snapshot")
			return nil
		}
		cfg.StopContainer = func(context.Context, EvictionTarget) error {
			mu.Lock()
			defer mu.Unlock()
			calls = append(calls, "stop")
			return nil
		}
		cfg.MarkWorkspaceEvicted = func(EvictionResult) bool {
			mu.Lock()
			defer mu.Unlock()
			calls = append(calls, "mark")
			return true
		}
		cfg.NotifyEviction = func(context.Context, EvictionResult) error {
			mu.Lock()
			defer mu.Unlock()
			calls = append(calls, "notify")
			return nil
		}
	})
	if err := controller.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer controller.Close()

	source.events <- oomPressureEvent("workspace-1", "container-1")

	waitForEvictionTest(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(calls) == 4
	}, "eviction did not complete")

	mu.Lock()
	defer mu.Unlock()
	want := []string{"snapshot", "stop", "mark", "notify"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %#v, want %#v", calls, want)
	}
}

func TestEvictionControllerDebouncesDuplicateContainerEvictions(t *testing.T) {
	source := newFakePressureSource()
	var snapshots atomic.Int32
	var stops atomic.Int32
	controller := testEvictionController(t, source, func(cfg *EvictionControllerConfig) {
		cfg.DebounceWindow = time.Minute
		cfg.SnapshotWorkspace = func(context.Context, EvictionTarget) error {
			snapshots.Add(1)
			return nil
		}
		cfg.StopContainer = func(context.Context, EvictionTarget) error {
			stops.Add(1)
			return nil
		}
	})

	event := oomPressureEvent("workspace-1", "container-1")
	controller.handleEvent(context.Background(), event)
	controller.handleEvent(context.Background(), event)

	if got := snapshots.Load(); got != 1 {
		t.Fatalf("snapshots = %d, want 1", got)
	}
	if got := stops.Load(); got != 1 {
		t.Fatalf("stops = %d, want 1", got)
	}
}

func TestEvictionControllerSerializesConcurrentEvictions(t *testing.T) {
	source := newFakePressureSource()
	var active atomic.Int32
	var maxActive atomic.Int32
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	controller := testEvictionController(t, source, func(cfg *EvictionControllerConfig) {
		cfg.DebounceWindow = time.Millisecond
		cfg.SnapshotWorkspace = func(context.Context, EvictionTarget) error {
			current := active.Add(1)
			for {
				observed := maxActive.Load()
				if current <= observed || maxActive.CompareAndSwap(observed, current) {
					break
				}
			}
			entered <- struct{}{}
			<-release
			active.Add(-1)
			return nil
		}
	})

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		controller.handleEvent(context.Background(), oomPressureEvent("workspace-1", "container-1"))
	}()

	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("first eviction did not enter snapshot")
	}

	wg.Add(1)
	go func() {
		defer wg.Done()
		controller.handleEvent(context.Background(), oomPressureEvent("workspace-2", "container-2"))
	}()

	select {
	case <-entered:
		t.Fatal("second eviction entered snapshot before first finished")
	case <-time.After(25 * time.Millisecond):
	}

	close(release)
	wg.Wait()

	if got := maxActive.Load(); got != 1 {
		t.Fatalf("max concurrent snapshots = %d, want 1", got)
	}
}

func TestEvictionControllerKeepsWorkspaceRecoverableAfterSnapshotTimeout(t *testing.T) {
	source := newFakePressureSource()
	var stopped atomic.Bool
	var marked atomic.Bool
	var notified atomic.Bool
	controller := testEvictionController(t, source, func(cfg *EvictionControllerConfig) {
		cfg.SnapshotTimeout = 20 * time.Millisecond
		cfg.SnapshotWorkspace = func(ctx context.Context, _ EvictionTarget) error {
			<-ctx.Done()
			return ctx.Err()
		}
		cfg.StopContainer = func(context.Context, EvictionTarget) error {
			stopped.Store(true)
			return nil
		}
		cfg.MarkWorkspaceEvicted = func(EvictionResult) bool {
			marked.Store(true)
			return true
		}
		cfg.NotifyEviction = func(context.Context, EvictionResult) error {
			notified.Store(true)
			return nil
		}
	})

	controller.handleEvent(context.Background(), oomPressureEvent("workspace-1", "container-1"))

	if stopped.Load() || marked.Load() || notified.Load() {
		t.Fatal("snapshot timeout stopped or finalized an unrecoverable eviction")
	}
}

func TestEvictionControllerKeepsWorkspaceRecoverableAfterSnapshotFailure(t *testing.T) {
	source := newFakePressureSource()
	var stopped atomic.Bool
	var marked atomic.Bool
	var notified atomic.Bool
	controller := testEvictionController(t, source, func(cfg *EvictionControllerConfig) {
		cfg.SnapshotWorkspace = func(context.Context, EvictionTarget) error {
			return errors.New("snapshot failed")
		}
		cfg.StopContainer = func(context.Context, EvictionTarget) error {
			stopped.Store(true)
			return nil
		}
		cfg.MarkWorkspaceEvicted = func(EvictionResult) bool {
			marked.Store(true)
			return true
		}
		cfg.NotifyEviction = func(context.Context, EvictionResult) error {
			notified.Store(true)
			return nil
		}
	})

	controller.handleEvent(context.Background(), oomPressureEvent("workspace-1", "container-1"))

	if stopped.Load() || marked.Load() || notified.Load() {
		t.Fatal("snapshot failure stopped or notified an unrecoverable eviction")
	}
}

func TestEvictionControllerRetriesDieEventAfterOOMSnapshotRace(t *testing.T) {
	source := newFakePressureSource()
	var snapshots, stops, notifications int
	controller := testEvictionController(t, source, func(cfg *EvictionControllerConfig) {
		cfg.DebounceWindow = time.Minute
		cfg.SnapshotWorkspace = func(context.Context, EvictionTarget) error {
			snapshots++
			if snapshots == 1 {
				return errors.New("container still transitioning")
			}
			return nil
		}
		cfg.StopContainer = func(context.Context, EvictionTarget) error {
			stops++
			return nil
		}
		cfg.NotifyEviction = func(context.Context, EvictionResult) error {
			notifications++
			return nil
		}
	})

	event := oomPressureEvent("workspace-1", "container-1")
	controller.handleEvent(context.Background(), event) // Docker oom
	controller.handleEvent(context.Background(), event) // Docker die/137

	if snapshots != 2 || stops != 1 || notifications != 1 {
		t.Fatalf("snapshots=%d stops=%d notifications=%d, want 2/1/1", snapshots, stops, notifications)
	}
}

func TestEvictionControllerSelectsLargestMemoryConsumerForSystemCriticalPressure(t *testing.T) {
	source := newFakePressureSource()
	source.setPressure(ResourcePressure{
		Level: PressureLevelCritical,
		Containers: []ContainerMetric{
			{ID: "small", Name: "small-container", MemUsageBytes: 1024},
			{ID: "large", Name: "large-container", MemUsageBytes: 4096},
		},
	})

	var evicted EvictionTarget
	controller := testEvictionController(t, source, func(cfg *EvictionControllerConfig) {
		cfg.ResolveWorkspace = func(_ context.Context, metric ContainerMetric) (WorkspaceContainer, bool) {
			if metric.ID == "large" {
				return WorkspaceContainer{WorkspaceID: "workspace-large", ContainerID: metric.ID, ContainerName: metric.Name}, true
			}
			return WorkspaceContainer{WorkspaceID: "workspace-small", ContainerID: metric.ID, ContainerName: metric.Name}, true
		}
		cfg.SnapshotWorkspace = func(_ context.Context, target EvictionTarget) error {
			evicted = target
			return nil
		}
	})

	controller.handleEvent(context.Background(), PressureEvent{
		Type:       PressureEventSystemMemory,
		Level:      PressureLevelCritical,
		OccurredAt: time.Now().UTC(),
	})

	if evicted.WorkspaceID != "workspace-large" || evicted.ContainerID != "large" {
		t.Fatalf("evicted target = %#v, want largest memory consumer", evicted)
	}
}

func TestEvictionControllerBoundsWorkspaceResolution(t *testing.T) {
	source := newFakePressureSource()
	source.setPressure(ResourcePressure{
		Level: PressureLevelCritical,
		Containers: []ContainerMetric{
			{ID: "blocked", Name: "blocked-container", MemUsageBytes: 4096},
		},
	})

	var snapshots atomic.Int32
	controller := testEvictionController(t, source, func(cfg *EvictionControllerConfig) {
		cfg.ResolveTimeout = 20 * time.Millisecond
		cfg.ResolveWorkspace = func(ctx context.Context, _ ContainerMetric) (WorkspaceContainer, bool) {
			<-ctx.Done()
			return WorkspaceContainer{}, false
		}
		cfg.SnapshotWorkspace = func(context.Context, EvictionTarget) error {
			snapshots.Add(1)
			return nil
		}
	})

	start := time.Now()
	controller.handleEvent(context.Background(), PressureEvent{
		Type:       PressureEventSystemMemory,
		Level:      PressureLevelCritical,
		OccurredAt: time.Now().UTC(),
	})

	if elapsed := time.Since(start); elapsed > 200*time.Millisecond {
		t.Fatalf("workspace resolution took %s, want bounded by ResolveTimeout", elapsed)
	}
	if snapshots.Load() != 0 {
		t.Fatalf("snapshot called after resolver timed out")
	}
}

func TestEvictionControllerWarningPressureDoesNotEvict(t *testing.T) {
	source := newFakePressureSource()
	var snapshots atomic.Int32
	var stops atomic.Int32
	controller := testEvictionController(t, source, func(cfg *EvictionControllerConfig) {
		cfg.SnapshotWorkspace = func(context.Context, EvictionTarget) error {
			snapshots.Add(1)
			return nil
		}
		cfg.StopContainer = func(context.Context, EvictionTarget) error {
			stops.Add(1)
			return nil
		}
	})

	controller.handleEvent(context.Background(), PressureEvent{
		Type:       PressureEventSystemMemory,
		Level:      PressureLevelWarning,
		OccurredAt: time.Now().UTC(),
	})

	if snapshots.Load() != 0 || stops.Load() != 0 {
		t.Fatalf("warning pressure triggered snapshot=%d stop=%d, want none", snapshots.Load(), stops.Load())
	}
}

func TestEvictionControllerRejectsUnverifiedOOMWorkspace(t *testing.T) {
	for _, claimed := range []string{"workspace-1", ""} {
		t.Run("claim="+claimed, func(t *testing.T) {
			source := newFakePressureSource()
			var snapshots int
			controller := testEvictionController(t, source, func(cfg *EvictionControllerConfig) {
				cfg.ResolveWorkspace = func(context.Context, ContainerMetric) (WorkspaceContainer, bool) { return WorkspaceContainer{}, false }
				cfg.SnapshotWorkspace = func(context.Context, EvictionTarget) error { snapshots++; return nil }
			})
			controller.handleEvent(context.Background(), oomPressureEvent(claimed, "container-1"))
			if snapshots != 0 {
				t.Fatal("unverified event caused snapshot")
			}
		})
	}
}

func TestEvictionControllerResolvesExitedOOMWithoutMetricsOrWorkspaceLabel(t *testing.T) {
	source := newFakePressureSource()
	var target EvictionTarget
	controller := testEvictionController(t, source, func(cfg *EvictionControllerConfig) {
		cfg.SnapshotWorkspace = func(_ context.Context, got EvictionTarget) error { target = got; return nil }
	})
	controller.handleEvent(context.Background(), oomPressureEvent("", "container-1"))
	if target.WorkspaceID != "workspace-1" || target.ContainerID != "container-1" {
		t.Fatalf("exited OOM target = %#v", target)
	}
}

func TestEvictionControllerRejectsMismatchedOOMClaim(t *testing.T) {
	source := newFakePressureSource()
	controller := testEvictionController(t, source, nil)
	if target, ok := controller.selectTarget(context.Background(), oomPressureEvent("workspace-2", "container-1")); ok {
		t.Fatalf("accepted forged workspace claim: %#v", target)
	}
}

func TestEvictionControllerStopFailureDoesNotFinalizeAndCanRetry(t *testing.T) {
	source := newFakePressureSource()
	now := time.Now()
	var stops, marks, notifications int
	controller := testEvictionController(t, source, func(cfg *EvictionControllerConfig) {
		cfg.Clock = func() time.Time { return now }
		cfg.StopContainer = func(context.Context, EvictionTarget) error {
			stops++
			if stops == 1 {
				return errors.New("Docker unavailable")
			}
			return nil
		}
		cfg.MarkWorkspaceEvicted = func(EvictionResult) bool { marks++; return true }
		cfg.NotifyEviction = func(context.Context, EvictionResult) error { notifications++; return nil }
	})
	event := oomPressureEvent("workspace-1", "container-1")
	controller.handleEvent(context.Background(), event)
	if marks != 0 || notifications != 0 {
		t.Fatal("failed stop finalized eviction")
	}
	now = now.Add(time.Minute)
	controller.handleEvent(context.Background(), event)
	if stops != 2 || marks != 1 || notifications != 1 {
		t.Fatalf("stops=%d marks=%d notifications=%d", stops, marks, notifications)
	}
}

func TestEvictionControllerSkipsRecoveredPressureAndSupersededRuntime(t *testing.T) {
	source := newFakePressureSource()
	var snapshots, notifications int
	controller := testEvictionController(t, source, func(cfg *EvictionControllerConfig) {
		cfg.SnapshotWorkspace = func(context.Context, EvictionTarget) error { snapshots++; return nil }
		cfg.MarkWorkspaceEvicted = func(EvictionResult) bool { return false }
		cfg.NotifyEviction = func(context.Context, EvictionResult) error { notifications++; return nil }
	})
	controller.handleEvent(context.Background(), PressureEvent{Type: PressureEventSystemMemory, Level: PressureLevelCritical})
	if snapshots != 0 {
		t.Fatal("stale pressure triggered eviction")
	}
	controller.handleEvent(context.Background(), oomPressureEvent("", "container-1"))
	if snapshots != 1 || notifications != 0 {
		t.Fatal("superseded eviction notified control plane")
	}
}

func TestEvictionControllerDoesNotSubstituteSameNameReplacement(t *testing.T) {
	source := newFakePressureSource()
	source.setPressure(ResourcePressure{Containers: []ContainerMetric{{ID: "replacement", Name: "app"}}})
	var resolvedID string
	controller := testEvictionController(t, source, func(cfg *EvictionControllerConfig) {
		cfg.ResolveWorkspace = func(_ context.Context, metric ContainerMetric) (WorkspaceContainer, bool) {
			resolvedID = metric.ID
			return WorkspaceContainer{}, false
		}
	})
	event := oomPressureEvent("", "old-container")
	event.ContainerName = "app"
	controller.handleEvent(context.Background(), event)
	if resolvedID != "old-container" {
		t.Fatalf("resolved stale event against %q", resolvedID)
	}
}

func TestEvictionControllerCloseCancelsSnapshotWithoutStopping(t *testing.T) {
	source := newFakePressureSource()
	entered := make(chan struct{})
	var stops atomic.Int32
	controller := testEvictionController(t, source, func(cfg *EvictionControllerConfig) {
		cfg.SnapshotTimeout = time.Hour
		cfg.SnapshotWorkspace = func(ctx context.Context, _ EvictionTarget) error { close(entered); <-ctx.Done(); return ctx.Err() }
		cfg.StopContainer = func(context.Context, EvictionTarget) error { stops.Add(1); return nil }
	})
	if err := controller.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	source.events <- oomPressureEvent("", "container-1")
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("snapshot missing")
	}
	done := make(chan struct{})
	go func() { controller.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not cancel snapshot")
	}
	if stops.Load() != 0 {
		t.Fatal("shutdown initiated a container stop")
	}
}

func TestEvictionControllerWaitsForSettlingWindowAndFreshPSI(t *testing.T) {
	source := newFakePressureSource()
	now := time.Now()
	var stopped []string
	state := ResourcePressure{Level: PressureLevelCritical,
		System:     SystemPressure{Memory: MemoryPressure{CollectedAt: now}},
		Containers: []ContainerMetric{{ID: "first", MemUsageBytes: 2}, {ID: "second", MemUsageBytes: 1}}}
	source.setPressure(state)
	controller := testEvictionController(t, source, func(cfg *EvictionControllerConfig) {
		cfg.Clock = func() time.Time { return now }
		cfg.StopContainer = func(_ context.Context, target EvictionTarget) error {
			stopped = append(stopped, target.ContainerID)
			return nil
		}
	})
	event := PressureEvent{Type: PressureEventSystemMemory, Level: PressureLevelCritical}
	controller.handleEvent(context.Background(), event)
	state.Containers = state.Containers[1:]
	state.System.Memory.CollectedAt = now.Add(time.Second)
	source.setPressure(state)
	now = now.Add(time.Second)
	controller.handleEvent(context.Background(), event)
	if len(stopped) != 1 {
		t.Fatal("evicted second workload during settling window")
	}
	state.System.Memory.CollectedAt = now.Add(-time.Second)
	source.setPressure(state)
	now = now.Add(time.Minute)
	controller.handleEvent(context.Background(), event)
	if len(stopped) != 1 {
		t.Fatal("evicted second workload using pre-stop PSI sample")
	}
	state.System.Memory.CollectedAt = now
	source.setPressure(state)
	controller.handleEvent(context.Background(), event)
	if !reflect.DeepEqual(stopped, []string{"first", "second"}) {
		t.Fatalf("stopped = %v", stopped)
	}
}

func TestEvictionControllerDoesNotStopAfterPressureRecoversDuringSnapshot(t *testing.T) {
	source := newFakePressureSource()
	source.setPressure(ResourcePressure{Level: PressureLevelCritical, Containers: []ContainerMetric{{ID: "first"}}})
	var stops int
	controller := testEvictionController(t, source, func(cfg *EvictionControllerConfig) {
		cfg.SnapshotWorkspace = func(context.Context, EvictionTarget) error {
			source.setPressure(ResourcePressure{Level: PressureLevelNone})
			return nil
		}
		cfg.StopContainer = func(context.Context, EvictionTarget) error { stops++; return nil }
	})
	controller.handleEvent(context.Background(), PressureEvent{Type: PressureEventSystemMemory, Level: PressureLevelCritical})
	if stops != 0 {
		t.Fatal("stopped workload after pressure recovered during snapshot")
	}
}
