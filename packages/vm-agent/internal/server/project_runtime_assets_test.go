package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
)

func TestFetchProjectRuntimeAssetsForWorkspace(t *testing.T) {
	const workspaceID = "ws-123"
	const callbackToken = "callback-token"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workspaces/ws-123/runtime-assets" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+callbackToken {
			t.Fatalf("unexpected auth header: %q", got)
		}
		_, _ = w.Write([]byte(`{"workspaceId":"ws-123","envVars":[{"key":"API_TOKEN","value":"secret-value","isSecret":true}],"files":[{"path":".env.local","content":"FOO=bar\n","isSecret":false}]}`))
	}))
	defer server.Close()

	s := &Server{
		config: &config.Config{
			ControlPlaneURL: server.URL,
			WorkspaceID:     workspaceID,
			CallbackToken:   callbackToken,
		},
	}

	assets, err := s.fetchProjectRuntimeAssetsForWorkspace(context.Background(), workspaceID, callbackToken)
	if err != nil {
		t.Fatalf("fetchProjectRuntimeAssetsForWorkspace returned error: %v", err)
	}

	if len(assets.EnvVars) != 1 {
		t.Fatalf("expected 1 env var, got %d", len(assets.EnvVars))
	}
	if assets.EnvVars[0].Key != "API_TOKEN" || assets.EnvVars[0].Value != "secret-value" {
		t.Fatalf("unexpected env var payload: %+v", assets.EnvVars[0])
	}
	if len(assets.Files) != 1 {
		t.Fatalf("expected 1 file, got %d", len(assets.Files))
	}
	if assets.Files[0].Path != ".env.local" || assets.Files[0].Content != "FOO=bar\n" {
		t.Fatalf("unexpected file payload: %+v", assets.Files[0])
	}
}

func TestFetchProjectRuntimeAssetsForWorkspaceHTTPError(t *testing.T) {
	const workspaceID = "ws-123"
	const callbackToken = "callback-token"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "forbidden", http.StatusForbidden)
	}))
	defer server.Close()

	s := &Server{
		config: &config.Config{
			ControlPlaneURL: server.URL,
			WorkspaceID:     workspaceID,
			CallbackToken:   callbackToken,
		},
	}

	_, err := s.fetchProjectRuntimeAssetsForWorkspace(context.Background(), workspaceID, callbackToken)
	if err == nil {
		t.Fatal("expected error when runtime-assets endpoint returns non-2xx")
	}
}
