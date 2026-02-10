package idle

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// lifecycleMockServer creates a mock control plane that handles both
// /heartbeat and /request-shutdown endpoints. Returns the server,
// a function to check if shutdown was requested, and counters.
type lifecycleServer struct {
	srv               *httptest.Server
	heartbeatCount    atomic.Int32
	shutdownRequested atomic.Bool
	mu                sync.Mutex
	heartbeatAction   string // "continue" or "shutdown"
}

func newLifecycleServer(t *testing.T) *lifecycleServer {
	t.Helper()
	ls := &lifecycleServer{
		heartbeatAction: "continue",
	}

	ls.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body.Close()
		_ = body

		// Route based on path suffix
		switch {
		case matchesSuffix(r.URL.Path, "/heartbeat"):
			ls.heartbeatCount.Add(1)
			ls.mu.Lock()
			action := ls.heartbeatAction
			ls.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{"action": action})

		case matchesSuffix(r.URL.Path, "/request-shutdown"):
			ls.shutdownRequested.Store(true)
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"status":"ok"}`))

		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))

	t.Cleanup(ls.srv.Close)
	return ls
}

func (ls *lifecycleServer) setHeartbeatAction(action string) {
	ls.mu.Lock()
	ls.heartbeatAction = action
	ls.mu.Unlock()
}

func matchesSuffix(path, suffix string) bool {
	return len(path) >= len(suffix) && path[len(path)-len(suffix):] == suffix
}

// TestE2E_IdleVM_ShutsDown verifies the full lifecycle: no activity →
// heartbeats are sent → idle timeout fires → shutdown channel closes.
func TestE2E_IdleVM_ShutsDown(t *testing.T) {
	ls := newLifecycleServer(t)

	d := NewDetectorWithConfig(DetectorConfig{
		Timeout:           150 * time.Millisecond,
		HeartbeatInterval: 50 * time.Millisecond,
		IdleCheckInterval: 30 * time.Millisecond,
		ControlPlaneURL:   ls.srv.URL,
		WorkspaceID:       "e2e-idle",
		CallbackToken:     "token",
	})

	go d.Start()
	defer d.Stop()

	// Wait for shutdown
	select {
	case <-d.ShutdownChannel():
		// Good — shutdown triggered
	case <-time.After(1 * time.Second):
		t.Fatal("Idle VM did not shut down within expected time")
	}

	// Verify at least one heartbeat was sent
	if ls.heartbeatCount.Load() < 1 {
		t.Error("Expected at least 1 heartbeat before shutdown")
	}
}

// TestE2E_ActiveThenIdleVM_ShutsDown verifies that activity keeps the VM
// alive, and shutdown fires after activity stops.
func TestE2E_ActiveThenIdleVM_ShutsDown(t *testing.T) {
	ls := newLifecycleServer(t)

	timeout := 150 * time.Millisecond
	d := NewDetectorWithConfig(DetectorConfig{
		Timeout:           timeout,
		HeartbeatInterval: 1 * time.Hour, // Don't need heartbeats for this test
		IdleCheckInterval: 30 * time.Millisecond,
		ControlPlaneURL:   ls.srv.URL,
		WorkspaceID:       "e2e-active-idle",
		CallbackToken:     "token",
	})

	go d.Start()
	defer d.Stop()

	// Simulate activity for 200ms (activity every 40ms)
	activityDone := make(chan struct{})
	go func() {
		for i := 0; i < 5; i++ {
			d.RecordActivity()
			time.Sleep(40 * time.Millisecond)
		}
		close(activityDone)
	}()

	// Shutdown should NOT fire while activity is happening
	select {
	case <-d.ShutdownChannel():
		t.Fatal("Shutdown fired while activity was ongoing")
	case <-activityDone:
		// Good - activity phase complete
	}

	// Record the time activity stopped
	activityStopTime := time.Now()

	// Now wait for shutdown to fire (should be ~150ms after last activity)
	select {
	case <-d.ShutdownChannel():
		elapsed := time.Since(activityStopTime)
		// Should fire roughly at the timeout duration after last activity
		if elapsed < 100*time.Millisecond {
			t.Errorf("Shutdown fired too early: %v after activity stopped (expected ~%v)", elapsed, timeout)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("VM did not shut down after activity stopped")
	}
}

// TestE2E_ContinuousActivityNeverShutsDown verifies that continuous activity
// prevents the shutdown channel from ever closing.
func TestE2E_ContinuousActivityNeverShutsDown(t *testing.T) {
	ls := newLifecycleServer(t)

	d := NewDetectorWithConfig(DetectorConfig{
		Timeout:           100 * time.Millisecond,
		HeartbeatInterval: 1 * time.Hour,
		IdleCheckInterval: 30 * time.Millisecond,
		ControlPlaneURL:   ls.srv.URL,
		WorkspaceID:       "e2e-continuous",
		CallbackToken:     "token",
	})

	go d.Start()
	defer d.Stop()

	// Keep recording activity for 400ms (4x the timeout)
	stopActivity := make(chan struct{})
	go func() {
		ticker := time.NewTicker(30 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stopActivity:
				return
			case <-ticker.C:
				d.RecordActivity()
			}
		}
	}()

	// Shutdown should NOT fire during continuous activity
	select {
	case <-d.ShutdownChannel():
		close(stopActivity)
		t.Fatal("Shutdown fired during continuous activity")
	case <-time.After(400 * time.Millisecond):
		// Good — still alive after 4x the timeout
	}

	close(stopActivity)

	// Now stop activity and verify shutdown fires
	select {
	case <-d.ShutdownChannel():
		// Good — shutdown fired after activity stopped
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Shutdown did not fire after activity stopped")
	}
}

// TestE2E_HeartbeatForcedShutdown verifies that a "shutdown" action from
// the heartbeat response causes immediate shutdown, even with a long timeout.
func TestE2E_HeartbeatForcedShutdown(t *testing.T) {
	ls := newLifecycleServer(t)
	ls.setHeartbeatAction("shutdown")

	d := NewDetectorWithConfig(DetectorConfig{
		Timeout:           1 * time.Hour, // Very long timeout
		HeartbeatInterval: 50 * time.Millisecond,
		IdleCheckInterval: 1 * time.Hour, // Very long — won't trigger idle
		ControlPlaneURL:   ls.srv.URL,
		WorkspaceID:       "e2e-forced",
		CallbackToken:     "token",
	})

	go d.Start()
	defer d.Stop()

	// Shutdown should fire quickly (from heartbeat response, not idle timeout)
	select {
	case <-d.ShutdownChannel():
		// Good — forced shutdown from control plane
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Heartbeat-forced shutdown did not fire")
	}

	if ls.heartbeatCount.Load() < 1 {
		t.Error("Expected at least 1 heartbeat")
	}
}

// TestE2E_UserTypesIntermittently verifies that intermittent user input
// (simulating real typing) keeps the VM alive, and shutdown fires at the
// correct time relative to the LAST input, not the first.
func TestE2E_UserTypesIntermittently(t *testing.T) {
	ls := newLifecycleServer(t)

	timeout := 150 * time.Millisecond
	d := NewDetectorWithConfig(DetectorConfig{
		Timeout:           timeout,
		HeartbeatInterval: 1 * time.Hour,
		IdleCheckInterval: 30 * time.Millisecond,
		ControlPlaneURL:   ls.srv.URL,
		WorkspaceID:       "e2e-intermittent",
		CallbackToken:     "token",
	})

	go d.Start()
	defer d.Stop()

	// Simulate: user types at t+0, t+50ms, t+100ms, then stops
	d.RecordActivity()
	time.Sleep(50 * time.Millisecond)
	d.RecordActivity()
	time.Sleep(50 * time.Millisecond)
	d.RecordActivity()

	lastInputTime := time.Now()

	// Shutdown should NOT fire immediately
	select {
	case <-d.ShutdownChannel():
		t.Fatal("Shutdown fired too early (before timeout after last input)")
	case <-time.After(80 * time.Millisecond):
		// Good — still within the idle timeout from last input
	}

	// But should fire within the timeout period
	select {
	case <-d.ShutdownChannel():
		elapsed := time.Since(lastInputTime)
		if elapsed < 100*time.Millisecond {
			t.Errorf("Shutdown fired too early: %v after last input (expected ~%v)", elapsed, timeout)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Shutdown did not fire after user stopped typing")
	}
}
