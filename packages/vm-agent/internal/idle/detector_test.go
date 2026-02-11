package idle

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
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

// TestAutonomousShutdown verifies that the VM shuts down autonomously
// when idle timeout is reached, regardless of control plane availability.
func TestAutonomousShutdown(t *testing.T) {
	// Create detector with very short timeout for testing
	timeout := 100 * time.Millisecond
	heartbeatInterval := 1 * time.Hour // Don't send heartbeats during test
	d := NewDetector(timeout, heartbeatInterval, "http://unreachable", "test", "token")

	// Set a very short idle check interval for testing
	d.idleCheckInterval = 50 * time.Millisecond

	// Get the shutdown channel
	shutdownCh := d.ShutdownChannel()

	// Start the detector
	go d.Start()
	defer d.Stop()

	// Channel should not be closed initially
	select {
	case <-shutdownCh:
		t.Error("Shutdown channel should not be closed initially")
	default:
		// Expected: channel is open
	}

	// Wait for idle timeout to pass
	// With 100ms timeout and 50ms check interval, shutdown should happen within 200ms
	select {
	case <-shutdownCh:
		// Success - VM initiated shutdown autonomously
	case <-time.After(500 * time.Millisecond):
		t.Fatal("VM did not shut down autonomously after idle timeout")
	}
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

// --- New tests below ---

// TestShutdownChannelClosesExactlyOnce verifies that the shutdown channel
// closes once and subsequent reads return immediately (closed channel behavior).
func TestShutdownChannelClosesExactlyOnce(t *testing.T) {
	d := NewDetectorWithConfig(DetectorConfig{
		Timeout:           100 * time.Millisecond,
		HeartbeatInterval: 1 * time.Hour,
		IdleCheckInterval: 50 * time.Millisecond,
		ControlPlaneURL:   "http://unreachable",
		WorkspaceID:       "test",
		CallbackToken:     "token",
	})

	go d.Start()
	defer d.Stop()

	// Wait for shutdown
	select {
	case <-d.ShutdownChannel():
		// Good - channel closed
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Shutdown channel did not close")
	}

	// Second read should also succeed immediately (closed channel)
	select {
	case <-d.ShutdownChannel():
		// Good - channel still closed
	default:
		t.Error("Second read from shutdown channel should succeed (channel is closed)")
	}
}

// TestMultipleActivitiesKeepExtendingDeadline verifies that repeated
// RecordActivity() calls keep pushing the deadline forward.
func TestMultipleActivitiesKeepExtendingDeadline(t *testing.T) {
	timeout := 200 * time.Millisecond
	d := NewDetectorWithConfig(DetectorConfig{
		Timeout:           timeout,
		HeartbeatInterval: 1 * time.Hour,
		ControlPlaneURL:   "http://localhost",
		WorkspaceID:       "test",
		CallbackToken:     "token",
	})

	var prevDeadline time.Time
	for i := 0; i < 5; i++ {
		time.Sleep(50 * time.Millisecond)
		d.RecordActivity()

		deadline := d.GetDeadline()
		if !prevDeadline.IsZero() && !deadline.After(prevDeadline) {
			t.Errorf("Activity %d: deadline did not advance (prev=%v, now=%v)", i, prevDeadline, deadline)
		}
		if d.IsIdle() {
			t.Errorf("Activity %d: should not be idle right after RecordActivity()", i)
		}
		prevDeadline = deadline
	}
}

// TestActivityAfterIdleResetsDeadline verifies that calling RecordActivity()
// after the detector has become idle resets IsIdle() to false.
func TestActivityAfterIdleResetsDeadline(t *testing.T) {
	timeout := 100 * time.Millisecond
	d := NewDetectorWithConfig(DetectorConfig{
		Timeout:           timeout,
		HeartbeatInterval: 1 * time.Hour,
		ControlPlaneURL:   "http://localhost",
		WorkspaceID:       "test",
		CallbackToken:     "token",
	})

	// Wait for idle
	time.Sleep(150 * time.Millisecond)
	if !d.IsIdle() {
		t.Fatal("Should be idle after timeout")
	}

	// Record activity to reset
	d.RecordActivity()
	if d.IsIdle() {
		t.Error("Should not be idle after RecordActivity()")
	}

	// Deadline should be ~100ms from now
	expectedDeadline := time.Now().Add(timeout)
	if diff := d.GetDeadline().Sub(expectedDeadline).Abs(); diff > 50*time.Millisecond {
		t.Errorf("Deadline not reset correctly: diff=%v", diff)
	}
}

// TestStopPreventsShutdown verifies that calling Stop() on the detector
// before idle timeout prevents the shutdown channel from being closed.
func TestStopPreventsShutdown(t *testing.T) {
	d := NewDetectorWithConfig(DetectorConfig{
		Timeout:           100 * time.Millisecond,
		HeartbeatInterval: 1 * time.Hour,
		IdleCheckInterval: 50 * time.Millisecond,
		ControlPlaneURL:   "http://unreachable",
		WorkspaceID:       "test",
		CallbackToken:     "token",
	})

	go d.Start()

	// Stop immediately before idle timeout
	time.Sleep(20 * time.Millisecond)
	d.Stop()

	// Wait past the idle timeout
	time.Sleep(200 * time.Millisecond)

	// Shutdown channel should NOT be closed (detector was stopped)
	select {
	case <-d.ShutdownChannel():
		t.Error("Shutdown channel should not close after Stop()")
	default:
		// Good - channel is still open
	}
}

// --- Heartbeat integration tests ---

// testServer creates an httptest.Server that captures requests and responds
// with configurable responses. Returns the server, a function to get captured
// requests, and a function to set the response handler.
type capturedRequest struct {
	Path   string
	Body   []byte
	Header http.Header
}

func newMockControlPlane(t *testing.T) (*httptest.Server, *[]capturedRequest, func(func(w http.ResponseWriter, r *http.Request))) {
	t.Helper()
	var mu sync.Mutex
	var requests []capturedRequest
	var handler func(w http.ResponseWriter, r *http.Request)

	// Default: return continue
	handler = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"action": "continue"})
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body.Close()
		mu.Lock()
		requests = append(requests, capturedRequest{
			Path:   r.URL.Path,
			Body:   body,
			Header: r.Header.Clone(),
		})
		h := handler
		mu.Unlock()
		h(w, r)
	}))

	setHandler := func(h func(w http.ResponseWriter, r *http.Request)) {
		mu.Lock()
		handler = h
		mu.Unlock()
	}

	t.Cleanup(srv.Close)
	return srv, &requests, setHandler
}

func getRequests(reqs *[]capturedRequest) []capturedRequest {
	// Return a copy for safe access
	return *reqs
}

// TestHeartbeatSendsCorrectPayload verifies that SendHeartbeat() sends
// the correct JSON payload, auth header, and URL path.
func TestHeartbeatSendsCorrectPayload(t *testing.T) {
	srv, reqs, _ := newMockControlPlane(t)

	d := NewDetectorWithConfig(DetectorConfig{
		Timeout:           30 * time.Minute,
		HeartbeatInterval: 1 * time.Hour,
		ControlPlaneURL:   srv.URL,
		WorkspaceID:       "ws-test-123",
		CallbackToken:     "my-secret-token",
	})

	d.SendHeartbeat()

	captured := getRequests(reqs)
	if len(captured) != 1 {
		t.Fatalf("Expected 1 request, got %d", len(captured))
	}

	req := captured[0]

	// Verify URL path
	expectedPath := "/api/workspaces/ws-test-123/heartbeat"
	if req.Path != expectedPath {
		t.Errorf("Expected path %s, got %s", expectedPath, req.Path)
	}

	// Verify auth header
	authHeader := req.Header.Get("Authorization")
	if authHeader != "Bearer my-secret-token" {
		t.Errorf("Expected auth header 'Bearer my-secret-token', got '%s'", authHeader)
	}

	// Verify content type
	contentType := req.Header.Get("Content-Type")
	if contentType != "application/json" {
		t.Errorf("Expected content type 'application/json', got '%s'", contentType)
	}

	// Verify body contains required fields
	var payload map[string]interface{}
	if err := json.Unmarshal(req.Body, &payload); err != nil {
		t.Fatalf("Failed to parse heartbeat body: %v", err)
	}

	for _, field := range []string{"workspaceId", "idleSeconds", "idle", "lastActivityAt", "shutdownDeadline"} {
		if _, ok := payload[field]; !ok {
			t.Errorf("Missing field '%s' in heartbeat payload", field)
		}
	}

	if payload["workspaceId"] != "ws-test-123" {
		t.Errorf("Expected workspaceId 'ws-test-123', got '%v'", payload["workspaceId"])
	}
}

// TestHeartbeatShutdownAction verifies that a "shutdown" action from the
// control plane closes the shutdown channel.
func TestHeartbeatShutdownAction(t *testing.T) {
	srv, _, setHandler := newMockControlPlane(t)
	setHandler(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"action": "shutdown"})
	})

	d := NewDetectorWithConfig(DetectorConfig{
		Timeout:           30 * time.Minute,
		HeartbeatInterval: 1 * time.Hour,
		ControlPlaneURL:   srv.URL,
		WorkspaceID:       "test",
		CallbackToken:     "token",
	})

	d.SendHeartbeat()

	// Shutdown channel should be closed
	select {
	case <-d.ShutdownChannel():
		// Good
	default:
		t.Error("Shutdown channel should be closed after 'shutdown' action")
	}
}

// TestHeartbeatContinueAction verifies that a "continue" action does NOT
// close the shutdown channel.
func TestHeartbeatContinueAction(t *testing.T) {
	srv, _, _ := newMockControlPlane(t) // default handler returns "continue"

	d := NewDetectorWithConfig(DetectorConfig{
		Timeout:           30 * time.Minute,
		HeartbeatInterval: 1 * time.Hour,
		ControlPlaneURL:   srv.URL,
		WorkspaceID:       "test",
		CallbackToken:     "token",
	})

	d.SendHeartbeat()

	select {
	case <-d.ShutdownChannel():
		t.Error("Shutdown channel should NOT be closed after 'continue' action")
	default:
		// Good
	}
}

// TestHeartbeatServerError verifies that a 500 response from the control
// plane does not crash or close the shutdown channel.
func TestHeartbeatServerError(t *testing.T) {
	srv, _, setHandler := newMockControlPlane(t)
	setHandler(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	d := NewDetectorWithConfig(DetectorConfig{
		Timeout:           30 * time.Minute,
		HeartbeatInterval: 1 * time.Hour,
		ControlPlaneURL:   srv.URL,
		WorkspaceID:       "test",
		CallbackToken:     "token",
	})

	// Should not panic
	d.SendHeartbeat()

	select {
	case <-d.ShutdownChannel():
		t.Error("Shutdown channel should not close on server error")
	default:
		// Good
	}
}

// TestHeartbeatUnreachableServer verifies that an unreachable control plane
// does not crash or block indefinitely.
func TestHeartbeatUnreachableServer(t *testing.T) {
	d := NewDetectorWithConfig(DetectorConfig{
		Timeout:           30 * time.Minute,
		HeartbeatInterval: 1 * time.Hour,
		ControlPlaneURL:   "http://127.0.0.1:1", // Nothing listening
		WorkspaceID:       "test",
		CallbackToken:     "token",
	})

	// Should not panic or block
	done := make(chan struct{})
	go func() {
		d.SendHeartbeat()
		close(done)
	}()

	select {
	case <-done:
		// Good - returned without blocking
	case <-time.After(15 * time.Second):
		t.Fatal("SendHeartbeat blocked on unreachable server")
	}

	select {
	case <-d.ShutdownChannel():
		t.Error("Shutdown channel should not close on unreachable server")
	default:
		// Good
	}
}

// TestHeartbeatMalformedResponse verifies that a malformed JSON response
// does not crash or close the shutdown channel.
func TestHeartbeatMalformedResponse(t *testing.T) {
	srv, _, setHandler := newMockControlPlane(t)
	setHandler(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("not valid json{{{"))
	})

	d := NewDetectorWithConfig(DetectorConfig{
		Timeout:           30 * time.Minute,
		HeartbeatInterval: 1 * time.Hour,
		ControlPlaneURL:   srv.URL,
		WorkspaceID:       "test",
		CallbackToken:     "token",
	})

	d.SendHeartbeat()

	select {
	case <-d.ShutdownChannel():
		t.Error("Shutdown channel should not close on malformed response")
	default:
		// Good
	}
}
