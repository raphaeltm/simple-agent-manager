package errorreport

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestNilReporterSafe(t *testing.T) {
	var r *Reporter

	// All methods should be no-ops on nil receiver
	r.Start()
	r.Report(ErrorEntry{Message: "test"})
	r.ReportError(fmt.Errorf("test"), "source", "ws-1", nil)
	r.Shutdown()
}

func TestReportQueuesEntries(t *testing.T) {
	r := New("http://localhost", "node-1", "token", Config{
		FlushInterval: 1 * time.Hour, // Don't auto-flush
		MaxBatchSize:  100,           // Don't trigger immediate flush
		MaxQueueSize:  50,
	})

	r.Report(ErrorEntry{Message: "err1", Source: "test"})
	r.Report(ErrorEntry{Message: "err2", Source: "test"})

	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.queue) != 2 {
		t.Errorf("expected 2 entries in queue, got %d", len(r.queue))
	}
}

func TestReportDropsWhenQueueFull(t *testing.T) {
	r := New("http://localhost", "node-1", "token", Config{
		FlushInterval: 1 * time.Hour,
		MaxBatchSize:  100,
		MaxQueueSize:  3,
	})

	r.Report(ErrorEntry{Message: "err1", Source: "test"})
	r.Report(ErrorEntry{Message: "err2", Source: "test"})
	r.Report(ErrorEntry{Message: "err3", Source: "test"})
	r.Report(ErrorEntry{Message: "err4-dropped", Source: "test"})

	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.queue) != 3 {
		t.Errorf("expected 3 entries (capped), got %d", len(r.queue))
	}
}

func TestAutoEnrichTimestamp(t *testing.T) {
	r := New("http://localhost", "node-1", "token", Config{
		FlushInterval: 1 * time.Hour,
		MaxBatchSize:  100,
		MaxQueueSize:  50,
	})

	r.Report(ErrorEntry{Message: "no-timestamp", Source: "test"})

	r.mu.Lock()
	defer r.mu.Unlock()
	if r.queue[0].Timestamp == "" {
		t.Error("expected timestamp to be auto-enriched")
	}
}

func TestPreserveExplicitTimestamp(t *testing.T) {
	r := New("http://localhost", "node-1", "token", Config{
		FlushInterval: 1 * time.Hour,
		MaxBatchSize:  100,
		MaxQueueSize:  50,
	})

	ts := "2026-01-01T00:00:00Z"
	r.Report(ErrorEntry{Message: "with-timestamp", Source: "test", Timestamp: ts})

	r.mu.Lock()
	defer r.mu.Unlock()
	if r.queue[0].Timestamp != ts {
		t.Errorf("expected timestamp %q, got %q", ts, r.queue[0].Timestamp)
	}
}

func TestImmediateFlushAtBatchSize(t *testing.T) {
	var mu sync.Mutex
	var received []ErrorEntry

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Errors []ErrorEntry `json:"errors"`
		}
		json.Unmarshal(body, &payload)

		mu.Lock()
		received = append(received, payload.Errors...)
		mu.Unlock()

		w.WriteHeader(204)
	}))
	defer srv.Close()

	r := New(srv.URL, "node-1", "test-token", Config{
		FlushInterval: 1 * time.Hour, // Only immediate flush
		MaxBatchSize:  3,
		MaxQueueSize:  50,
		HTTPTimeout:   5 * time.Second,
	})

	// Add 3 entries — should trigger immediate flush
	r.Report(ErrorEntry{Message: "err1", Source: "test"})
	r.Report(ErrorEntry{Message: "err2", Source: "test"})
	r.Report(ErrorEntry{Message: "err3", Source: "test"})

	// Wait briefly for the async flush goroutine
	time.Sleep(500 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if len(received) != 3 {
		t.Errorf("expected 3 entries flushed, got %d", len(received))
	}
}

func TestShutdownFlushesRemaining(t *testing.T) {
	var mu sync.Mutex
	var received []ErrorEntry

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Errors []ErrorEntry `json:"errors"`
		}
		json.Unmarshal(body, &payload)

		mu.Lock()
		received = append(received, payload.Errors...)
		mu.Unlock()

		w.WriteHeader(204)
	}))
	defer srv.Close()

	r := New(srv.URL, "node-1", "test-token", Config{
		FlushInterval: 1 * time.Hour, // Don't auto-flush
		MaxBatchSize:  100,
		MaxQueueSize:  50,
		HTTPTimeout:   5 * time.Second,
	})
	r.Start()

	r.Report(ErrorEntry{Message: "remaining1", Source: "test"})
	r.Report(ErrorEntry{Message: "remaining2", Source: "test"})

	// Shutdown should flush remaining entries
	r.Shutdown()

	mu.Lock()
	defer mu.Unlock()
	if len(received) != 2 {
		t.Errorf("expected 2 entries flushed on shutdown, got %d", len(received))
	}
}

func TestSendIncludesAuthHeader(t *testing.T) {
	var authHeader string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader = r.Header.Get("Authorization")
		w.WriteHeader(204)
	}))
	defer srv.Close()

	r := New(srv.URL, "node-42", "my-secret-token", Config{
		FlushInterval: 1 * time.Hour,
		MaxBatchSize:  100,
		MaxQueueSize:  50,
		HTTPTimeout:   5 * time.Second,
	})

	r.Report(ErrorEntry{Message: "test", Source: "test"})
	r.flush()

	if authHeader != "Bearer my-secret-token" {
		t.Errorf("expected auth header 'Bearer my-secret-token', got %q", authHeader)
	}
}

func TestSendURLContainsNodeID(t *testing.T) {
	var requestPath string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestPath = r.URL.Path
		w.WriteHeader(204)
	}))
	defer srv.Close()

	r := New(srv.URL, "node-abc", "token", Config{
		FlushInterval: 1 * time.Hour,
		MaxBatchSize:  100,
		MaxQueueSize:  50,
		HTTPTimeout:   5 * time.Second,
	})

	r.Report(ErrorEntry{Message: "test", Source: "test"})
	r.flush()

	expected := "/api/nodes/node-abc/errors"
	if requestPath != expected {
		t.Errorf("expected path %q, got %q", expected, requestPath)
	}
}

func TestHTTPFailureDoesNotPanic(t *testing.T) {
	// Point at a server that always errors
	r := New("http://localhost:1", "node-1", "token", Config{
		FlushInterval: 1 * time.Hour,
		MaxBatchSize:  100,
		MaxQueueSize:  50,
		HTTPTimeout:   100 * time.Millisecond,
	})

	r.Report(ErrorEntry{Message: "test", Source: "test"})
	r.flush() // Should not panic
}

func TestReportError(t *testing.T) {
	r := New("http://localhost", "node-1", "token", Config{
		FlushInterval: 1 * time.Hour,
		MaxBatchSize:  100,
		MaxQueueSize:  50,
	})

	r.ReportError(fmt.Errorf("something broke"), "acp-gateway", "ws-123", map[string]interface{}{
		"step": "agent_start",
	})

	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.queue) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(r.queue))
	}

	entry := r.queue[0]
	if entry.Level != "error" {
		t.Errorf("expected level 'error', got %q", entry.Level)
	}
	if entry.Message != "something broke" {
		t.Errorf("expected message 'something broke', got %q", entry.Message)
	}
	if entry.Source != "acp-gateway" {
		t.Errorf("expected source 'acp-gateway', got %q", entry.Source)
	}
	if entry.WorkspaceID != "ws-123" {
		t.Errorf("expected workspaceID 'ws-123', got %q", entry.WorkspaceID)
	}
	if entry.Context["step"] != "agent_start" {
		t.Errorf("expected context step 'agent_start', got %v", entry.Context["step"])
	}
}

func TestReportErrorNilError(t *testing.T) {
	r := New("http://localhost", "node-1", "token", Config{
		FlushInterval: 1 * time.Hour,
		MaxBatchSize:  100,
		MaxQueueSize:  50,
	})

	r.ReportError(nil, "test", "", nil)

	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.queue) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(r.queue))
	}
	if r.queue[0].Message != "unknown error" {
		t.Errorf("expected 'unknown error', got %q", r.queue[0].Message)
	}
}

func TestDefaultConfig(t *testing.T) {
	r := New("http://localhost", "node-1", "token", Config{})

	if r.config.FlushInterval != 30*time.Second {
		t.Errorf("expected default flush interval 30s, got %v", r.config.FlushInterval)
	}
	if r.config.MaxBatchSize != 10 {
		t.Errorf("expected default max batch size 10, got %d", r.config.MaxBatchSize)
	}
	if r.config.MaxQueueSize != 100 {
		t.Errorf("expected default max queue size 100, got %d", r.config.MaxQueueSize)
	}
	if r.config.HTTPTimeout != 10*time.Second {
		t.Errorf("expected default HTTP timeout 10s, got %v", r.config.HTTPTimeout)
	}
}
