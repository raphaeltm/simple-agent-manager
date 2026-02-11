package idle

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// TestRequestShutdown_SuccessFirstAttempt verifies that a successful first attempt
// returns nil and makes exactly 1 request with correct URL, auth, and body.
func TestRequestShutdown_SuccessFirstAttempt(t *testing.T) {
	var requestCount atomic.Int32
	var capturedPath string
	var capturedAuth string
	var capturedBody []byte

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount.Add(1)
		capturedPath = r.URL.Path
		capturedAuth = r.Header.Get("Authorization")
		capturedBody, _ = io.ReadAll(r.Body)
		r.Body.Close()
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	}))
	defer srv.Close()

	err := RequestShutdown(ShutdownConfig{
		ControlPlaneURL: srv.URL,
		WorkspaceID:     "ws-abc-123",
		CallbackToken:   "secret-token",
		MaxAttempts:     3,
		RetryDelay:      10 * time.Millisecond,
		HTTPTimeout:     5 * time.Second,
	})

	if err != nil {
		t.Fatalf("Expected nil error, got: %v", err)
	}

	if requestCount.Load() != 1 {
		t.Errorf("Expected 1 request, got %d", requestCount.Load())
	}

	expectedPath := "/api/workspaces/ws-abc-123/request-shutdown"
	if capturedPath != expectedPath {
		t.Errorf("Expected path %q, got %q", expectedPath, capturedPath)
	}

	if capturedAuth != "Bearer secret-token" {
		t.Errorf("Expected auth header 'Bearer secret-token', got %q", capturedAuth)
	}

	var body map[string]string
	if err := json.Unmarshal(capturedBody, &body); err != nil {
		t.Fatalf("Failed to parse request body: %v", err)
	}
	if body["reason"] != "idle_timeout" {
		t.Errorf("Expected reason 'idle_timeout', got %q", body["reason"])
	}
}

// TestRequestShutdown_RetriesOnFailure verifies that the function retries
// on 500 errors and succeeds when the server eventually returns 200.
func TestRequestShutdown_RetriesOnFailure(t *testing.T) {
	var requestCount atomic.Int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		r.Body.Close()
		n := requestCount.Add(1)
		if n < 3 {
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte(`{"error":"temporary failure"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	}))
	defer srv.Close()

	err := RequestShutdown(ShutdownConfig{
		ControlPlaneURL: srv.URL,
		WorkspaceID:     "test",
		CallbackToken:   "token",
		MaxAttempts:     3,
		RetryDelay:      10 * time.Millisecond,
		HTTPTimeout:     5 * time.Second,
	})

	if err != nil {
		t.Fatalf("Expected nil error after retries, got: %v", err)
	}

	if requestCount.Load() != 3 {
		t.Errorf("Expected 3 requests (2 failures + 1 success), got %d", requestCount.Load())
	}
}

// TestRequestShutdown_AllRetriesFail verifies that when all retries fail,
// the function returns an error and makes exactly MaxAttempts requests.
func TestRequestShutdown_AllRetriesFail(t *testing.T) {
	var requestCount atomic.Int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		r.Body.Close()
		requestCount.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"persistent failure"}`))
	}))
	defer srv.Close()

	err := RequestShutdown(ShutdownConfig{
		ControlPlaneURL: srv.URL,
		WorkspaceID:     "test",
		CallbackToken:   "token",
		MaxAttempts:     3,
		RetryDelay:      10 * time.Millisecond,
		HTTPTimeout:     5 * time.Second,
	})

	if err == nil {
		t.Fatal("Expected error after all retries failed, got nil")
	}

	if requestCount.Load() != 3 {
		t.Errorf("Expected 3 requests, got %d", requestCount.Load())
	}
}

// TestRequestShutdown_AcceptedResponse verifies that a 202 Accepted response
// is treated as success (not just 200 OK).
func TestRequestShutdown_AcceptedResponse(t *testing.T) {
	var requestCount atomic.Int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		r.Body.Close()
		requestCount.Add(1)
		w.WriteHeader(http.StatusAccepted)
		w.Write([]byte(`{"status":"accepted"}`))
	}))
	defer srv.Close()

	err := RequestShutdown(ShutdownConfig{
		ControlPlaneURL: srv.URL,
		WorkspaceID:     "test",
		CallbackToken:   "token",
		MaxAttempts:     3,
		RetryDelay:      10 * time.Millisecond,
		HTTPTimeout:     5 * time.Second,
	})

	if err != nil {
		t.Fatalf("Expected nil error for 202 Accepted, got: %v", err)
	}

	if requestCount.Load() != 1 {
		t.Errorf("Expected 1 request (no retries needed), got %d", requestCount.Load())
	}
}

// TestRequestShutdown_UnreachableServer verifies that an unreachable server
// results in an error after all retries are exhausted.
func TestRequestShutdown_UnreachableServer(t *testing.T) {
	err := RequestShutdown(ShutdownConfig{
		ControlPlaneURL: "http://127.0.0.1:1", // Nothing listening
		WorkspaceID:     "test",
		CallbackToken:   "token",
		MaxAttempts:     2,
		RetryDelay:      10 * time.Millisecond,
		HTTPTimeout:     50 * time.Millisecond,
	})

	if err == nil {
		t.Fatal("Expected error for unreachable server, got nil")
	}
}
