package ports

import (
	"fmt"
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
