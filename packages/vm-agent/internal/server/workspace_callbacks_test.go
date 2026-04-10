package server

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

func TestSyncCredential(t *testing.T) {
	t.Run("sends credential sync payload with workspace callback token", func(t *testing.T) {
		t.Parallel()

		called := false
		controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			called = true

			if r.Method != http.MethodPost {
				t.Fatalf("expected POST, got %s", r.Method)
			}
			if r.URL.Path != "/api/workspaces/ws-codex/agent-credential-sync" {
				t.Fatalf("unexpected path: %s", r.URL.Path)
			}
			if got := r.Header.Get("Authorization"); got != "Bearer ws-callback-token" {
				t.Fatalf("unexpected auth header: %s", got)
			}

			var payload map[string]string
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("decode payload: %v", err)
			}
			if payload["agentType"] != "openai-codex" {
				t.Fatalf("unexpected agentType: %q", payload["agentType"])
			}
			if payload["credentialKind"] != "oauth-token" {
				t.Fatalf("unexpected credentialKind: %q", payload["credentialKind"])
			}
			if payload["credential"] != `{"tokens":{"access_token":"new"}}` {
				t.Fatalf("unexpected credential: %q", payload["credential"])
			}

			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"success":true,"updated":true}`))
		}))
		defer controlPlane.Close()

		s := &Server{
			config: &config.Config{
				ControlPlaneURL: controlPlane.URL,
				HTTPReadTimeout: 5 * time.Second,
			},
			workspaces: map[string]*WorkspaceRuntime{
				"ws-codex": {ID: "ws-codex", CallbackToken: "ws-callback-token"},
			},
		}

		err := s.SyncCredential(
			context.Background(),
			"ws-codex",
			"openai-codex",
			"oauth-token",
			`{"tokens":{"access_token":"new"}}`,
		)
		if err != nil {
			t.Fatalf("expected no error, got %v", err)
		}
		if !called {
			t.Fatal("expected callback request to be sent")
		}
	})

	t.Run("falls back to node callback token", func(t *testing.T) {
		t.Parallel()

		called := false
		controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			called = true
			if got := r.Header.Get("Authorization"); got != "Bearer node-token" {
				t.Fatalf("unexpected auth header: %s", got)
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"success":true}`))
		}))
		defer controlPlane.Close()

		s := &Server{
			config: &config.Config{
				ControlPlaneURL: controlPlane.URL,
				HTTPReadTimeout: 5 * time.Second,
				CallbackToken:   "node-token",
			},
		}

		err := s.SyncCredential(
			context.Background(),
			"ws-unknown",
			"openai-codex",
			"oauth-token",
			"cred-data",
		)
		if err != nil {
			t.Fatalf("expected no error, got %v", err)
		}
		if !called {
			t.Fatal("expected callback request to be sent")
		}
	})

	t.Run("returns error for empty workspace ID", func(t *testing.T) {
		t.Parallel()

		s := &Server{config: &config.Config{}}
		err := s.SyncCredential(context.Background(), "", "openai-codex", "oauth-token", "cred")
		if err == nil {
			t.Fatal("expected error for empty workspace ID")
		}
	})

	t.Run("returns error when no callback token available", func(t *testing.T) {
		t.Parallel()

		s := &Server{config: &config.Config{}}
		err := s.SyncCredential(context.Background(), "ws-123", "openai-codex", "oauth-token", "cred")
		if err == nil {
			t.Fatal("expected error when no callback token is available")
		}
		if !strings.Contains(err.Error(), "no callback token") {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("returns error when control plane rejects with 4xx", func(t *testing.T) {
		t.Parallel()

		controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte("bad request"))
		}))
		defer controlPlane.Close()

		s := &Server{
			config: &config.Config{
				ControlPlaneURL: controlPlane.URL,
				HTTPReadTimeout: 5 * time.Second,
				CallbackToken:   "token",
			},
		}

		err := s.SyncCredential(context.Background(), "ws-123", "openai-codex", "oauth-token", "cred")
		if err == nil {
			t.Fatal("expected error for 4xx response")
		}
		if !strings.Contains(err.Error(), "HTTP 400") {
			t.Fatalf("expected HTTP 400 error, got: %v", err)
		}
	})
}

func TestNotifyWorkspaceProvisioningFailed(t *testing.T) {
	t.Run("sends callback payload with auth", func(t *testing.T) {
		t.Parallel()

		callbackToken := "test-callback-token"
		called := false
		controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			called = true

			if r.Method != http.MethodPost {
				t.Fatalf("expected POST, got %s", r.Method)
			}
			if r.URL.Path != "/api/workspaces/ws-123/provisioning-failed" {
				t.Fatalf("unexpected path: %s", r.URL.Path)
			}

			if got := r.Header.Get("Authorization"); got != "Bearer "+callbackToken {
				t.Fatalf("unexpected auth header: %s", got)
			}

			var payload map[string]string
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("decode payload: %v", err)
			}
			if payload["errorMessage"] != "devcontainer up failed: signal: killed" {
				t.Fatalf("unexpected errorMessage payload: %q", payload["errorMessage"])
			}

			w.WriteHeader(http.StatusOK)
		}))
		defer controlPlane.Close()

		s := &Server{
			config: &config.Config{
				ControlPlaneURL: controlPlane.URL,
				HTTPReadTimeout: 5 * time.Second,
			},
		}

		err := s.notifyWorkspaceProvisioningFailed(
			context.Background(),
			"ws-123",
			callbackToken,
			"devcontainer up failed: signal: killed",
		)
		if err != nil {
			t.Fatalf("expected no error, got %v", err)
		}
		if !called {
			t.Fatal("expected callback request to be sent")
		}
	})

	t.Run("returns error when callback endpoint fails after retries", func(t *testing.T) {
		t.Parallel()

		controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte("control-plane-error"))
		}))
		defer controlPlane.Close()

		s := &Server{
			config: &config.Config{
				ControlPlaneURL: controlPlane.URL,
				HTTPReadTimeout: 5 * time.Second,
			},
		}

		// Use a short-lived context to limit retry duration in tests
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		defer cancel()

		err := s.notifyWorkspaceProvisioningFailed(ctx, "ws-123", "token", "")
		if err == nil {
			t.Fatal("expected error for non-2xx callback response")
		}
		// Error could be from context cancellation or retry exhaustion
		if !strings.Contains(err.Error(), "HTTP 500") && !strings.Contains(err.Error(), "context") {
			t.Fatalf("expected HTTP 500 or context error, got %v", err)
		}
	})
}
