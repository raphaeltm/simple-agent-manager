package idle

import (
	"testing"
	"time"
)

// TestDeadlineExtendsOnActivity verifies that RecordActivity() extends
// the shutdown deadline by the timeout period.
func TestDeadlineExtendsOnActivity(t *testing.T) {
	timeout := 30 * time.Minute
	heartbeatInterval := 1 * time.Minute
	controlPlaneURL := "http://localhost:8787"
	workspaceID := "test-workspace"
	callbackToken := "test-token"

	d := NewDetector(timeout, heartbeatInterval, controlPlaneURL, workspaceID, callbackToken)

	// Get initial deadline
	initialDeadline := d.GetDeadline()

	// Initial deadline should be approximately timeout from now
	expectedInitial := time.Now().Add(timeout)
	if diff := initialDeadline.Sub(expectedInitial).Abs(); diff > 100*time.Millisecond {
		t.Errorf("Initial deadline not set correctly: got %v, expected ~%v (diff: %v)",
			initialDeadline, expectedInitial, diff)
	}

	// Wait a bit
	time.Sleep(100 * time.Millisecond)

	// Record activity
	d.RecordActivity()

	// Get new deadline
	newDeadline := d.GetDeadline()

	// New deadline should be later than initial deadline
	if !newDeadline.After(initialDeadline) {
		t.Errorf("Deadline did not extend: initial=%v, new=%v",
			initialDeadline, newDeadline)
	}

	// New deadline should be approximately timeout from now
	expectedNew := time.Now().Add(timeout)
	if diff := newDeadline.Sub(expectedNew).Abs(); diff > 100*time.Millisecond {
		t.Errorf("New deadline not set correctly: got %v, expected ~%v (diff: %v)",
			newDeadline, expectedNew, diff)
	}

	// The difference between new and initial should be approximately 100ms
	diff := newDeadline.Sub(initialDeadline)
	if diff < 50*time.Millisecond || diff > 200*time.Millisecond {
		t.Errorf("Deadline extension unexpected: got %v, expected ~100ms", diff)
	}
}

// TestDeadlineAccessIsConcurrentSafe verifies that GetDeadline() and
// RecordActivity() can be called concurrently without race conditions.
func TestDeadlineAccessIsConcurrentSafe(t *testing.T) {
	timeout := 30 * time.Minute
	heartbeatInterval := 1 * time.Minute
	d := NewDetector(timeout, heartbeatInterval, "http://localhost", "test", "token")

	done := make(chan bool)

	// Writer goroutine
	go func() {
		for i := 0; i < 100; i++ {
			d.RecordActivity()
			time.Sleep(1 * time.Millisecond)
		}
		done <- true
	}()

	// Reader goroutine
	go func() {
		for i := 0; i < 100; i++ {
			_ = d.GetDeadline()
			time.Sleep(1 * time.Millisecond)
		}
		done <- true
	}()

	// Wait for both goroutines
	<-done
	<-done

	// Verify final deadline is set
	deadline := d.GetDeadline()
	if deadline.IsZero() {
		t.Error("Deadline should not be zero after concurrent access")
	}
}

// TestIsIdleUsesDeadline verifies that IsIdle() correctly uses the deadline.
func TestIsIdleUsesDeadline(t *testing.T) {
	// Create detector with short timeout for testing
	timeout := 100 * time.Millisecond
	heartbeatInterval := 1 * time.Hour // Don't send heartbeats during test
	d := NewDetector(timeout, heartbeatInterval, "http://localhost", "test", "token")

	// Initially should not be idle
	if d.IsIdle() {
		t.Error("Detector should not be idle immediately after creation")
	}

	// Wait for timeout to pass
	time.Sleep(150 * time.Millisecond)

	// Now should be idle
	if !d.IsIdle() {
		t.Error("Detector should be idle after timeout period")
	}

	// Record activity to extend deadline
	d.RecordActivity()

	// Should no longer be idle
	if d.IsIdle() {
		t.Error("Detector should not be idle after recording activity")
	}
}

// TestGetIdleTimeConsistentWithDeadline verifies that GetIdleTime()
// returns values consistent with the deadline.
func TestGetIdleTimeConsistentWithDeadline(t *testing.T) {
	timeout := 30 * time.Minute
	heartbeatInterval := 1 * time.Hour
	d := NewDetector(timeout, heartbeatInterval, "http://localhost", "test", "token")

	deadline := d.GetDeadline()
	idleTime := d.GetIdleTime()

	// deadline should be approximately (now + timeout - idleTime)
	expectedDeadline := time.Now().Add(timeout).Add(-idleTime)
	if diff := deadline.Sub(expectedDeadline).Abs(); diff > 100*time.Millisecond {
		t.Errorf("Deadline inconsistent with idle time: deadline=%v, idleTime=%v, expected=%v (diff: %v)",
			deadline, idleTime, expectedDeadline, diff)
	}
}
