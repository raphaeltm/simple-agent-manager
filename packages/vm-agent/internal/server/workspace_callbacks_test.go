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

	t.Run("returns error when callback endpoint fails", func(t *testing.T) {
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

		err := s.notifyWorkspaceProvisioningFailed(context.Background(), "ws-123", "token", "")
		if err == nil {
			t.Fatal("expected error for non-2xx callback response")
		}
		if !strings.Contains(err.Error(), "HTTP 500") {
			t.Fatalf("expected HTTP 500 in error, got %v", err)
		}
	})
}
