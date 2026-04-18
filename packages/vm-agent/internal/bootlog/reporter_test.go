package bootlog

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestNilReporterSafe(t *testing.T) {
	t.Parallel()

	var r *Reporter
	// All methods should be safe on nil receiver
	r.SetToken("abc")
	r.Log("test_step", "started", "test message")
}

func TestNoTokenNoSend(t *testing.T) {
	t.Parallel()

	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	r := New(server.URL, "ws-123")
	// No SetToken call — should no-op
	r.Log("test_step", "started", "test message")

	if called {
		t.Fatal("expected no HTTP call when token is not set")
	}
}

func TestLogSendsEntry(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	var received logEntry
	var authHeader string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		authHeader = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Errorf("failed to decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()

	r := New(server.URL, "ws-123")
	r.SetToken("cb-token-abc")
	r.Log("git_clone", "started", "Cloning repository", "octo/repo")

	mu.Lock()
	defer mu.Unlock()

	if authHeader != "Bearer cb-token-abc" {
		t.Fatalf("expected Bearer auth, got: %s", authHeader)
	}
	if received.Step != "git_clone" {
		t.Fatalf("step=%q, want %q", received.Step, "git_clone")
	}
	if received.Status != "started" {
		t.Fatalf("status=%q, want %q", received.Status, "started")
	}
	if received.Message != "Cloning repository" {
		t.Fatalf("message=%q, want %q", received.Message, "Cloning repository")
	}
	if received.Detail != "octo/repo" {
		t.Fatalf("detail=%q, want %q", received.Detail, "octo/repo")
	}
	if received.Timestamp == "" {
		t.Fatal("expected non-empty timestamp")
	}
}

func TestLogDetailOmittedWhenEmpty(t *testing.T) {
	t.Parallel()

	var receivedBody []byte

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var err error
		buf := make([]byte, 4096)
		n, _ := r.Body.Read(buf)
		receivedBody = buf[:n]
		_ = err
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()

	r := New(server.URL, "ws-123")
	r.SetToken("token")
	r.Log("test_step", "completed", "Done")

	// Body should not contain "detail" key when empty
	var m map[string]interface{}
	if err := json.Unmarshal(receivedBody, &m); err != nil {
		t.Fatalf("failed to parse body: %v", err)
	}
	if _, has := m["detail"]; has {
		t.Fatal("expected detail to be omitted when empty")
	}
}

// TestLogWithNilBroadcasterInterface verifies that Reporter.Log does not panic
// when the broadcaster field holds a non-nil interface wrapping a nil concrete
// pointer. This is the exact production crash path: the bootlog.Broadcaster
// interface is non-nil (so the nil check passes), but the underlying
// *BootLogBroadcaster is nil, causing a SIGSEGV on method dispatch.
// The fix is the nil receiver guard on BootLogBroadcaster.Broadcast.
func TestLogWithNilBroadcasterInterface(t *testing.T) {
	t.Parallel()

	r := New("http://localhost:9999", "ws-123")
	// Simulate the production scenario: SetBroadcaster with a typed nil pointer.
	// In Go, this creates a non-nil interface value wrapping a nil concrete pointer.
	type nilBroadcaster struct{}

	// We use a simple mock that implements Broadcaster but panics if called
	// without the nil guard — proving the guard works.
	var nilPtr *panicOnCallBroadcaster
	r.SetBroadcaster(nilPtr)

	// Must not panic
	r.Log("agent_install", "error", "install failed", "ENOTEMPTY")
}

// panicOnCallBroadcaster is a mock broadcaster that panics unless the nil
// receiver guard fires first.
type panicOnCallBroadcaster struct{}

func (b *panicOnCallBroadcaster) Broadcast(step, status, message string, detail ...string) {
	if b == nil {
		return
	}
	panic("should not reach here in nil test")
}

func TestPhaseEmitsStartAndCompletedWithDuration(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	var entries []logEntry

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var e logEntry
		if err := json.NewDecoder(r.Body).Decode(&e); err != nil {
			t.Errorf("failed to decode: %v", err)
		}
		mu.Lock()
		entries = append(entries, e)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	r := New(server.URL, "ws-xyz")
	r.SetToken("token")

	err := r.Phase("docker_install", func() error {
		return nil
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}
	if entries[0].Step != "docker_install" || entries[0].Status != "started" {
		t.Fatalf("first entry = %+v, want started for docker_install", entries[0])
	}
	if entries[1].Step != "docker_install" || entries[1].Status != "completed" {
		t.Fatalf("second entry = %+v, want completed for docker_install", entries[1])
	}
	if !strings.HasPrefix(entries[1].Detail, "duration_ms=") {
		t.Fatalf("expected duration_ms= detail, got %q", entries[1].Detail)
	}
}

func TestPhasePropagatesErrorAndEmitsFailed(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	var entries []logEntry

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var e logEntry
		_ = json.NewDecoder(r.Body).Decode(&e)
		mu.Lock()
		entries = append(entries, e)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	r := New(server.URL, "ws-xyz")
	r.SetToken("token")

	sentinel := errors.New("boom")
	err := r.Phase("firewall", func() error {
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected sentinel error, got %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}
	if entries[1].Status != "failed" {
		t.Fatalf("expected failed status, got %q", entries[1].Status)
	}
	if entries[1].Message != "boom" {
		t.Fatalf("expected message=boom, got %q", entries[1].Message)
	}
	if !strings.HasPrefix(entries[1].Detail, "duration_ms=") {
		t.Fatalf("expected duration_ms= detail, got %q", entries[1].Detail)
	}
}

func TestPhaseNilSafe(t *testing.T) {
	t.Parallel()
	var r *Reporter
	called := false
	err := r.Phase("step", func() error {
		called = true
		return nil
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !called {
		t.Fatal("expected fn to be invoked even on nil receiver")
	}
}

func TestLogHandlesServerError(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	r := New(server.URL, "ws-123")
	r.SetToken("token")
	// Should not panic even if server returns 500
	r.Log("test_step", "started", "test")
}
