package bootlog

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
