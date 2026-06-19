package server

import (
	"testing"

	"github.com/workspace/vm-agent/internal/config"
)

func TestPublishCallbackTokenUsesWorkspaceTokenAfterNodeRefresh(t *testing.T) {
	cfg := &config.Config{
		WorkspaceID:   "ws-publish",
		CallbackToken: "boot-workspace-token",
	}
	s := &Server{
		config:        cfg,
		callbackToken: "refreshed-node-token",
		workspaces: map[string]*WorkspaceRuntime{
			"ws-publish": {ID: "ws-publish", CallbackToken: "runtime-workspace-token"},
		},
	}

	if got := s.publishCallbackToken(); got != "runtime-workspace-token" {
		t.Fatalf("publishCallbackToken() = %q, want workspace token", got)
	}
}

func TestPublishCallbackTokenFallsBackToBootWorkspaceToken(t *testing.T) {
	cfg := &config.Config{
		WorkspaceID:   "ws-publish",
		CallbackToken: "boot-workspace-token",
	}
	s := &Server{
		config:        cfg,
		callbackToken: "refreshed-node-token",
		workspaces:    map[string]*WorkspaceRuntime{},
	}

	if got := s.publishCallbackToken(); got != "boot-workspace-token" {
		t.Fatalf("publishCallbackToken() = %q, want boot workspace token", got)
	}
}
