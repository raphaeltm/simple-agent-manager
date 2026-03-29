package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
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

// TestTwoWorkspaceGitTokenIsolation verifies that fetcher closures for two
// different workspaces on the same node use separate workspace IDs and callback
// tokens — the canonical multi-tenant isolation test for the per-session fix.
func TestTwoWorkspaceGitTokenIsolation(t *testing.T) {
	t.Parallel()

	type request struct {
		path string
		auth string
	}
	var mu sync.Mutex
	requests := make(map[string]request) // keyed by workspace ID from path

	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests[r.URL.Path] = request{path: r.URL.Path, auth: r.Header.Get("Authorization")}
		mu.Unlock()

		// Return a workspace-specific token so callers can verify isolation.
		token := "ghs_unknown"
		if r.URL.Path == "/api/workspaces/ws-alpha/git-token" {
			token = "ghs_alpha_token"
		} else if r.URL.Path == "/api/workspaces/ws-beta/git-token" {
			token = "ghs_beta_token"
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token":"` + token + `","expiresAt":"2026-01-01T00:00:00Z"}`))
	}))
	defer controlPlane.Close()

	s := &Server{
		config: &config.Config{
			ControlPlaneURL: controlPlane.URL,
			WorkspaceID:     "ws-node-level",
			CallbackToken:   "node-token",
		},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-alpha": {ID: "ws-alpha", CallbackToken: "alpha-callback"},
			"ws-beta":  {ID: "ws-beta", CallbackToken: "beta-callback"},
		},
	}

	// Build per-session closures the same way getOrCreateSessionHost does.
	fetcherAlpha := func() (string, error) {
		return s.fetchGitTokenForWorkspace(t.Context(), "ws-alpha", "")
	}
	fetcherBeta := func() (string, error) {
		return s.fetchGitTokenForWorkspace(t.Context(), "ws-beta", "")
	}

	tokenA, err := fetcherAlpha()
	if err != nil {
		t.Fatalf("alpha fetcher error: %v", err)
	}
	tokenB, err := fetcherBeta()
	if err != nil {
		t.Fatalf("beta fetcher error: %v", err)
	}

	// Verify tokens are workspace-specific (no cross-contamination).
	if tokenA != "ghs_alpha_token" {
		t.Errorf("alpha got wrong token: %q", tokenA)
	}
	if tokenB != "ghs_beta_token" {
		t.Errorf("beta got wrong token: %q", tokenB)
	}

	// Verify each fetcher hit its own workspace endpoint.
	mu.Lock()
	defer mu.Unlock()
	alphaReq := requests["/api/workspaces/ws-alpha/git-token"]
	betaReq := requests["/api/workspaces/ws-beta/git-token"]

	if alphaReq.auth != "Bearer alpha-callback" {
		t.Errorf("alpha used wrong callback token: %q", alphaReq.auth)
	}
	if betaReq.auth != "Bearer beta-callback" {
		t.Errorf("beta used wrong callback token: %q", betaReq.auth)
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
