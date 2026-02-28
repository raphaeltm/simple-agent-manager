package bootstrap

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

// =============================================================================
// markWorkspaceReady — Callback Request Shape Contract
// =============================================================================

func TestReadyCallbackRequestShape(t *testing.T) {
	t.Parallel()

	var receivedPayload map[string]string
	var receivedAuth string
	var receivedPath string
	var receivedMethod string
	var receivedContentType string

	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedMethod = r.Method
		receivedPath = r.URL.Path
		receivedAuth = r.Header.Get("Authorization")
		receivedContentType = r.Header.Get("Content-Type")
		_ = json.NewDecoder(r.Body).Decode(&receivedPayload)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer controlPlane.Close()

	cfg := &config.Config{
		WorkspaceID:     "ws-ready-test",
		ControlPlaneURL: controlPlane.URL,
		CallbackToken:   "test-jwt-token",
	}

	err := markWorkspaceReady(context.Background(), cfg, "running")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify HTTP method
	if receivedMethod != http.MethodPost {
		t.Fatalf("expected POST, got %s", receivedMethod)
	}

	// Verify path
	if receivedPath != "/api/workspaces/ws-ready-test/ready" {
		t.Fatalf("unexpected path: %s", receivedPath)
	}

	// Verify auth header
	if receivedAuth != "Bearer test-jwt-token" {
		t.Fatalf("unexpected auth: %s", receivedAuth)
	}

	// Verify content type
	if receivedContentType != "application/json" {
		t.Fatalf("expected Content-Type=application/json, got %s", receivedContentType)
	}

	// Verify payload shape
	if receivedPayload["status"] != "running" {
		t.Fatalf("expected status=running, got %q", receivedPayload["status"])
	}
}

func TestReadyCallbackRecoveryStatus(t *testing.T) {
	t.Parallel()

	var receivedPayload map[string]string
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&receivedPayload)
		w.WriteHeader(http.StatusOK)
	}))
	defer controlPlane.Close()

	cfg := &config.Config{
		WorkspaceID:     "ws-recovery-test",
		ControlPlaneURL: controlPlane.URL,
		CallbackToken:   "token",
	}

	err := markWorkspaceReady(context.Background(), cfg, "recovery")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if receivedPayload["status"] != "recovery" {
		t.Fatalf("expected status=recovery, got %q", receivedPayload["status"])
	}
}

func TestReadyCallbackDefaultsToRunning(t *testing.T) {
	t.Parallel()

	var receivedPayload map[string]string
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&receivedPayload)
		w.WriteHeader(http.StatusOK)
	}))
	defer controlPlane.Close()

	cfg := &config.Config{
		WorkspaceID:     "ws-default-test",
		ControlPlaneURL: controlPlane.URL,
		CallbackToken:   "token",
	}

	// Empty status should default to "running"
	err := markWorkspaceReady(context.Background(), cfg, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if receivedPayload["status"] != "running" {
		t.Fatalf("expected default status=running, got %q", receivedPayload["status"])
	}
}

func TestReadyCallbackNon2xxReturnsError(t *testing.T) {
	t.Parallel()

	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("overloaded"))
	}))
	defer controlPlane.Close()

	cfg := &config.Config{
		WorkspaceID:     "ws-fail-test",
		ControlPlaneURL: controlPlane.URL,
		CallbackToken:   "token",
	}

	// Use a short-lived context to limit retry duration in tests
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	err := markWorkspaceReady(ctx, cfg, "running")
	if err == nil {
		t.Fatal("expected error for non-2xx response")
	}
	// Error could be from context cancellation or retry exhaustion
	if !strings.Contains(err.Error(), "503") && !strings.Contains(err.Error(), "context") {
		t.Fatalf("expected HTTP 503 or context error, got %v", err)
	}
}

func TestReadyCallbackURLConstruction(t *testing.T) {
	t.Parallel()

	var receivedPath string
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	defer controlPlane.Close()

	// Trailing slash should be trimmed from ControlPlaneURL
	cfg := &config.Config{
		WorkspaceID:     "ws-url-test",
		ControlPlaneURL: controlPlane.URL + "/",
		CallbackToken:   "token",
	}

	err := markWorkspaceReady(context.Background(), cfg, "running")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Should not have double slash
	if strings.Contains(receivedPath, "//") {
		t.Fatalf("path contains double slash: %s", receivedPath)
	}
	if receivedPath != "/api/workspaces/ws-url-test/ready" {
		t.Fatalf("unexpected path: %s", receivedPath)
	}
}
