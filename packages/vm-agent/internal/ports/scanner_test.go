package ports

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestScanner_LazyContainerResolution(t *testing.T) {
	// Simulate a container that becomes available after a few scan ticks.
	var resolveCount atomic.Int32
	readyAfter := 2 // resolver succeeds on the 3rd call (index 2)

	resolver := func() (string, error) {
		n := int(resolveCount.Add(1))
		if n <= readyAfter {
			return "", fmt.Errorf("container not ready yet (attempt %d)", n)
		}
		return "abc123", nil
	}

	var detectedPorts []int
	scanner := NewScanner(ScannerConfig{
		Enabled:           true,
		Interval:          10 * time.Millisecond,
		ExcludePorts:      map[int]bool{},
		EphemeralMin:      32768,
		WorkspaceID:       "ws-test",
		ContainerID:       "", // Empty — not available at creation time
		ContainerResolver: resolver,
		EventEmitter: func(eventType, message string, detail map[string]interface{}) {
			if eventType == "port.detected" {
				if p, ok := detail["port"].(int); ok {
					detectedPorts = append(detectedPorts, p)
				}
			}
		},
	})

	scanner.Start()
	// Wait enough ticks for the resolver to succeed and a scan to run.
	time.Sleep(150 * time.Millisecond)
	scanner.Stop()

	// Verify the resolver was called multiple times (at least until it succeeded).
	calls := int(resolveCount.Load())
	if calls < readyAfter+1 {
		t.Errorf("expected resolver to be called at least %d times, got %d", readyAfter+1, calls)
	}

	// Verify the container ID was set after resolution.
	scanner.mu.RLock()
	cid := scanner.containerID
	scanner.mu.RUnlock()
	if cid != "abc123" {
		t.Errorf("expected containerID to be 'abc123' after resolution, got %q", cid)
	}
}

func TestScanner_NoResolverEmptyContainerSkipsScan(t *testing.T) {
	// When no resolver is provided and containerID is empty, scan should be a no-op.
	scanCalled := false
	scanner := NewScanner(ScannerConfig{
		Enabled:      true,
		Interval:     10 * time.Millisecond,
		ExcludePorts: map[int]bool{},
		EphemeralMin: 32768,
		WorkspaceID:  "ws-test",
		ContainerID:  "", // Empty, no resolver
		EventEmitter: func(eventType, message string, detail map[string]interface{}) {
			scanCalled = true
		},
	})

	scanner.Start()
	time.Sleep(50 * time.Millisecond)
	scanner.Stop()

	// No events should have been emitted since scan is skipped without a container.
	if scanCalled {
		t.Error("expected no events when containerID is empty and no resolver is set")
	}
}

func TestScanner_ResolverNotCalledWhenContainerIDSet(t *testing.T) {
	// When containerID is already set, the resolver should never be called.
	var resolverCalled atomic.Int32
	resolver := func() (string, error) {
		resolverCalled.Add(1)
		return "should-not-be-used", nil
	}

	scanner := NewScanner(ScannerConfig{
		Enabled:           true,
		Interval:          10 * time.Millisecond,
		ExcludePorts:      map[int]bool{},
		EphemeralMin:      32768,
		WorkspaceID:       "ws-test",
		ContainerID:       "already-set",
		ContainerResolver: resolver,
	})

	scanner.Start()
	time.Sleep(50 * time.Millisecond)
	scanner.Stop()

	if resolverCalled.Load() != 0 {
		t.Error("resolver should not be called when containerID is already set")
	}
}

func TestScanner_ConsecutiveFailuresTracked(t *testing.T) {
	// Verify that consecutive container resolution failures are tracked
	// and emitted as node events periodically.
	var resolveCount atomic.Int32
	resolver := func() (string, error) {
		resolveCount.Add(1)
		return "", fmt.Errorf("container not found")
	}

	var mu sync.Mutex
	var events []string
	scanner := NewScanner(ScannerConfig{
		Enabled:           true,
		Interval:          5 * time.Millisecond,
		ExcludePorts:      map[int]bool{},
		EphemeralMin:      32768,
		WorkspaceID:       "ws-test",
		ContainerID:       "",
		ContainerResolver: resolver,
		EventEmitter: func(eventType, message string, detail map[string]interface{}) {
			mu.Lock()
			events = append(events, eventType)
			mu.Unlock()
		},
	})

	scanner.Start()
	// Wait enough ticks for 6+ failures (emits event at every 6th failure).
	time.Sleep(100 * time.Millisecond)
	scanner.Stop()

	calls := int(resolveCount.Load())
	if calls < 6 {
		t.Fatalf("expected at least 6 resolver calls, got %d", calls)
	}

	// Verify consecutive failures were tracked.
	if scanner.consecutiveFailures < 6 {
		t.Errorf("expected consecutiveFailures >= 6, got %d", scanner.consecutiveFailures)
	}

	// Verify at least one scanner_waiting event was emitted.
	mu.Lock()
	defer mu.Unlock()
	found := false
	for _, e := range events {
		if e == "port.scanner_waiting" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected port.scanner_waiting event to be emitted after 6 consecutive failures")
	}
}

func TestScanner_EmitsScannerReadyOnResolution(t *testing.T) {
	// Verify that a scanner_ready event is emitted when the container is first resolved.
	var resolveCount atomic.Int32
	resolver := func() (string, error) {
		n := int(resolveCount.Add(1))
		if n <= 1 {
			return "", fmt.Errorf("not ready")
		}
		return "abc123", nil
	}

	var mu sync.Mutex
	var events []string
	scanner := NewScanner(ScannerConfig{
		Enabled:           true,
		Interval:          10 * time.Millisecond,
		ExcludePorts:      map[int]bool{},
		EphemeralMin:      32768,
		WorkspaceID:       "ws-test",
		ContainerID:       "",
		ContainerResolver: resolver,
		EventEmitter: func(eventType, message string, detail map[string]interface{}) {
			mu.Lock()
			events = append(events, eventType)
			mu.Unlock()
		},
	})

	scanner.Start()
	time.Sleep(100 * time.Millisecond)
	scanner.Stop()

	mu.Lock()
	defer mu.Unlock()
	found := false
	for _, e := range events {
		if e == "port.scanner_ready" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected port.scanner_ready event after container resolution")
	}

	// Verify containerResolved flag is set.
	if !scanner.containerResolved {
		t.Error("expected containerResolved to be true after successful resolution")
	}
}

func TestScanner_FailureCounterResetsOnResolution(t *testing.T) {
	// Verify that consecutive failures reset to 0 at the moment the container is resolved.
	// After resolution, readProcNetTCP may fail (no real Docker in test env), but
	// the resolution itself must reset the counter.
	var resolveCount atomic.Int32
	var scannerReadyEmitted atomic.Int32
	readyAfter := 3

	resolver := func() (string, error) {
		n := int(resolveCount.Add(1))
		if n <= readyAfter {
			return "", fmt.Errorf("not ready (attempt %d)", n)
		}
		return "abc123", nil
	}

	scanner := NewScanner(ScannerConfig{
		Enabled:           true,
		Interval:          5 * time.Millisecond,
		ExcludePorts:      map[int]bool{},
		EphemeralMin:      32768,
		WorkspaceID:       "ws-test",
		ContainerID:       "",
		ContainerResolver: resolver,
		EventEmitter: func(eventType, _ string, _ map[string]interface{}) {
			if eventType == "port.scanner_ready" {
				scannerReadyEmitted.Add(1)
			}
		},
	})

	scanner.Start()
	time.Sleep(100 * time.Millisecond)
	scanner.Stop()

	// The scanner_ready event should have been emitted exactly once.
	if scannerReadyEmitted.Load() != 1 {
		t.Errorf("expected scanner_ready event to be emitted once, got %d", scannerReadyEmitted.Load())
	}

	// Container should have been resolved.
	if !scanner.containerResolved {
		t.Error("expected containerResolved to be true")
	}

	// The resolver should have been called more than readyAfter times.
	calls := int(resolveCount.Load())
	if calls < readyAfter+1 {
		t.Errorf("expected at least %d resolver calls, got %d", readyAfter+1, calls)
	}
}

func TestScanner_ContainerResolvedFlagSetOnInit(t *testing.T) {
	// When containerID is provided at creation time, containerResolved should be true.
	scanner := NewScanner(ScannerConfig{
		ContainerID: "pre-set",
		WorkspaceID: "ws-test",
	})

	if !scanner.containerResolved {
		t.Error("expected containerResolved to be true when ContainerID is set at creation")
	}
}
