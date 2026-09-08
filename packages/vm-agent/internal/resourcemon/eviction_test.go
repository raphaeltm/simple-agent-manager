package resourcemon

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"reflect"
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
				WorkspaceID:   "ws-" + metric.ID,
				ContainerID:   metric.ID,
				ContainerName: metric.Name,
			}, true
		},
		SnapshotWorkspace: func(context.Context, EvictionTarget) error { return nil },
		StopContainer:     func(context.Context, EvictionTarget) error { return nil },
		MarkWorkspaceEvicted: func(EvictionResult) {
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
		cfg.MarkWorkspaceEvicted = func(EvictionResult) {
			mu.Lock()
			defer mu.Unlock()
			calls = append(calls, "mark")
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

func TestEvictionControllerStopsContainerAfterSnapshotTimeout(t *testing.T) {
	source := newFakePressureSource()
	var stopped atomic.Bool
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
	})

	controller.handleEvent(context.Background(), oomPressureEvent("workspace-1", "container-1"))

	if !stopped.Load() {
		t.Fatal("container stop was not called after snapshot timeout")
	}
}

func TestEvictionControllerStopsContainerAfterSnapshotFailure(t *testing.T) {
	source := newFakePressureSource()
	var stopped atomic.Bool
	controller := testEvictionController(t, source, func(cfg *EvictionControllerConfig) {
		cfg.SnapshotWorkspace = func(context.Context, EvictionTarget) error {
			return errors.New("snapshot failed")
		}
		cfg.StopContainer = func(context.Context, EvictionTarget) error {
			stopped.Store(true)
			return nil
		}
	})

	controller.handleEvent(context.Background(), oomPressureEvent("workspace-1", "container-1"))

	if !stopped.Load() {
		t.Fatal("container stop was not called after snapshot failure")
	}
}

func TestEvictionControllerSelectsLargestMemoryConsumerForSystemCriticalPressure(t *testing.T) {
	source := newFakePressureSource()
	source.setPressure(ResourcePressure{
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
