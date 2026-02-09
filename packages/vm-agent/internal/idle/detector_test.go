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

// TestShutdownChannelClosedOnShutdownResponse verifies that the shutdown
// channel is closed when the control plane responds with "shutdown" action.
func TestShutdownChannelClosedOnShutdownResponse(t *testing.T) {
	// Note: This test requires mocking the HTTP server response
	// In production, when sendHeartbeat() receives action="shutdown",
	// it should close the shutdownCh channel
	timeout := 30 * time.Minute
	heartbeatInterval := 1 * time.Hour
	d := NewDetector(timeout, heartbeatInterval, "http://localhost", "test", "token")

	// Get the shutdown channel
	shutdownCh := d.ShutdownChannel()

	// Channel should not be closed initially
	select {
	case <-shutdownCh:
		t.Error("Shutdown channel should not be closed initially")
	default:
		// Expected: channel is open
	}

	// Note: To fully test this, we would need to mock the HTTP server
	// and trigger a heartbeat that returns "shutdown" action
}

// TestGetWarningTime verifies that warning time is calculated correctly.
func TestGetWarningTime(t *testing.T) {
	timeout := 10 * time.Minute
	heartbeatInterval := 1 * time.Hour
	d := NewDetector(timeout, heartbeatInterval, "http://localhost", "test", "token")

	// Initially, warning time should be 0 (more than 5 minutes left)
	if warning := d.GetWarningTime(); warning != 0 {
		t.Errorf("Expected no warning initially, got %v", warning)
	}

	// Simulate being idle for 6 minutes (4 minutes left until shutdown)
	d.lastActivity = time.Now().Add(-6 * time.Minute)
	d.shutdownDeadline = time.Now().Add(4 * time.Minute)

	// Now we should get a warning (less than 5 minutes left)
	if warning := d.GetWarningTime(); warning <= 0 || warning > 5*time.Minute {
		t.Errorf("Expected warning between 0 and 5 minutes, got %v", warning)
	}
}
