package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
)

func TestBootMessageReporterWorkspaceIDRequiresRealWorkspace(t *testing.T) {
	t.Parallel()

	cfg := &config.Config{
		NodeID:        "node-123",
		ProjectID:     "project-123",
		ChatSessionID: "session-123",
	}

	if workspaceID, ok := bootMessageReporterWorkspaceID(cfg); ok || workspaceID != "" {
		t.Fatalf("boot reporter workspace = (%q, %v), want disabled without workspace ID", workspaceID, ok)
	}

	cfg.WorkspaceID = "workspace-123"
	workspaceID, ok := bootMessageReporterWorkspaceID(cfg)
	if !ok {
		t.Fatal("expected boot reporter to be enabled with real workspace ID")
	}
	if workspaceID != "workspace-123" {
		t.Fatalf("workspaceID = %q, want workspace-123", workspaceID)
	}
}

func TestTaskCompletionCallbacksAreBoundToTaskAndWorkspace(t *testing.T) {
	t.Parallel()

	type callbackRequest struct {
		Path          string
		Authorization string
		Body          map[string]interface{}
	}
	var requests []callbackRequest

	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode callback body: %v", err)
		}
		requests = append(requests, callbackRequest{
			Path:          r.URL.Path,
			Authorization: r.Header.Get("Authorization"),
			Body:          body,
		})
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(controlPlane.Close)

	s := &Server{
		config:        &config.Config{HTTPCallbackTimeout: 0},
		callbackToken: "workspace-token",
	}

	callbackA := s.makeTaskCompletionCallback(controlPlane.URL, "project-1", "task-a", "workspace-a", config.TaskModeConversation)
	callbackB := s.makeTaskCompletionCallback(controlPlane.URL, "project-1", "task-b", "workspace-b", config.TaskModeConversation)

	callbackA("end_turn", nil)
	callbackB("end_turn", nil)

	if len(requests) != 2 {
		t.Fatalf("callback request count = %d, want 2", len(requests))
	}
	if !strings.Contains(requests[0].Path, "/tasks/task-a/status/callback") {
		t.Fatalf("first callback path = %q, want task-a callback", requests[0].Path)
	}
	if !strings.Contains(requests[1].Path, "/tasks/task-b/status/callback") {
		t.Fatalf("second callback path = %q, want task-b callback", requests[1].Path)
	}
	for i, req := range requests {
		if req.Authorization != "Bearer workspace-token" {
			t.Fatalf("request %d authorization = %q, want workspace token", i, req.Authorization)
		}
		if req.Body["executionStep"] != "awaiting_followup" {
			t.Fatalf("request %d executionStep = %v, want awaiting_followup", i, req.Body["executionStep"])
		}
		gitPushResult, ok := req.Body["gitPushResult"].(map[string]interface{})
		if !ok {
			t.Fatalf("request %d missing gitPushResult object", i)
		}
		if pushed := gitPushResult["pushed"]; pushed != false {
			t.Fatalf("request %d pushed = %v, want false for conversation mode", i, pushed)
		}
	}
}
