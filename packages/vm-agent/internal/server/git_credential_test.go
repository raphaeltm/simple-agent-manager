package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
)

func TestHandleGitCredentialRequiresCallbackAuth(t *testing.T) {
	t.Parallel()

	s := &Server{
		config: &config.Config{
			CallbackToken: "callback-token",
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/git-credential", nil)
	rec := httptest.NewRecorder()
	s.handleGitCredential(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestHandleGitCredentialSuccess(t *testing.T) {
	t.Parallel()

	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("expected POST method, got %s", r.Method)
		}
		if r.URL.Path != "/api/workspaces/ws-123/git-token" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer callback-token" {
			t.Fatalf("unexpected Authorization header: %q", r.Header.Get("Authorization"))
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token":"ghs_test_token","expiresAt":"2026-01-01T00:00:00Z"}`))
	}))
	defer controlPlane.Close()

	s := &Server{
		config: &config.Config{
			ControlPlaneURL: controlPlane.URL,
			WorkspaceID:     "ws-123",
			CallbackToken:   "callback-token",
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/git-credential", nil)
	req.Header.Set("Authorization", "Bearer callback-token")

	rec := httptest.NewRecorder()
	s.handleGitCredential(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	got := rec.Body.String()
	want := "protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghs_test_token\n\n"
	if got != want {
		t.Fatalf("unexpected body:\n%s\nwant:\n%s", got, want)
	}
}

func TestHandleGitCredentialControlPlaneFailure(t *testing.T) {
	t.Parallel()

	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"internal","message":"boom"}`))
	}))
	defer controlPlane.Close()

	s := &Server{
		config: &config.Config{
			ControlPlaneURL: controlPlane.URL,
			WorkspaceID:     "ws-123",
			CallbackToken:   "callback-token",
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/git-credential", nil)
	req.Header.Set("Authorization", "Bearer callback-token")

	rec := httptest.NewRecorder()
	s.handleGitCredential(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", rec.Code)
	}

	var payload map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("expected JSON error body, got: %v", err)
	}
	if payload["error"] == "" {
		t.Fatal("expected error message in response body")
	}
}

func TestHandleGitCredentialUsesWorkspaceScopedTokenAndWorkspaceID(t *testing.T) {
	t.Parallel()

	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("expected POST method, got %s", r.Method)
		}
		if r.URL.Path != "/api/workspaces/ws-abc/git-token" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer workspace-callback-token" {
			t.Fatalf("unexpected Authorization header: %q", r.Header.Get("Authorization"))
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token":"ghs_workspace_token","expiresAt":"2026-01-01T00:00:00Z"}`))
	}))
	defer controlPlane.Close()

	s := &Server{
		config: &config.Config{
			ControlPlaneURL: controlPlane.URL,
			CallbackToken:   "node-callback-token",
		},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-abc": {
				ID:            "ws-abc",
				CallbackToken: "workspace-callback-token",
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/git-credential?workspaceId=ws-abc", nil)
	req.Header.Set("Authorization", "Bearer workspace-callback-token")

	rec := httptest.NewRecorder()
	s.handleGitCredential(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	got := rec.Body.String()
	want := "protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghs_workspace_token\n\n"
	if got != want {
		t.Fatalf("unexpected body:\n%s\nwant:\n%s", got, want)
	}
}
