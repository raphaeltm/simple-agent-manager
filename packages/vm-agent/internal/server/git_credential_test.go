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

// TestPerSessionGitTokenFetcherUsesCorrectWorkspaceID verifies that a
// per-session closure built from fetchGitTokenForWorkspace hits the correct
// workspace's git-token endpoint rather than the node-level s.config.WorkspaceID.
// This is the regression test for the GH_TOKEN-empty-in-workspaces bug where
// multi-workspace nodes used the wrong workspace ID.
func TestPerSessionGitTokenFetcherUsesCorrectWorkspaceID(t *testing.T) {
	t.Parallel()

	var requestedPath string
	var requestedAuth string
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.Path
		requestedAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token":"ghs_session_token","expiresAt":"2026-01-01T00:00:00Z"}`))
	}))
	defer controlPlane.Close()

	s := &Server{
		config: &config.Config{
			ControlPlaneURL: controlPlane.URL,
			// Node-level workspace ID — should NOT be used by per-session fetcher.
			WorkspaceID:   "ws-node-level",
			CallbackToken: "node-callback-token",
		},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-session-123": {
				ID:            "ws-session-123",
				CallbackToken: "session-callback-token",
			},
		},
	}

	// Build the same per-session closure that getOrCreateSessionHost creates.
	sessionWorkspaceID := "ws-session-123"
	fetcher := func() (string, error) {
		return s.fetchGitTokenForWorkspace(t.Context(), sessionWorkspaceID, "")
	}

	token, err := fetcher()
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if token != "ghs_session_token" {
		t.Fatalf("expected ghs_session_token, got %q", token)
	}
	// The request must target the SESSION workspace, not the node-level one.
	wantPath := "/api/workspaces/ws-session-123/git-token"
	if requestedPath != wantPath {
		t.Fatalf("fetcher hit wrong workspace path:\n  got:  %s\n  want: %s", requestedPath, wantPath)
	}
	// It should use the workspace-scoped callback token, not the node-level one.
	if requestedAuth != "Bearer session-callback-token" {
		t.Fatalf("fetcher used wrong callback token:\n  got:  %s\n  want: Bearer session-callback-token", requestedAuth)
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
