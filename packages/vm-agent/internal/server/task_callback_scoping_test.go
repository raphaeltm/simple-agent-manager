package server

import (
	"context"
	"encoding/json"
	"errors"
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

// runTaskCompletionCallback invokes a single task-completion callback against a
// stub control plane and returns the JSON body the control plane received. It
// centralizes the httptest server + Server fixture so individual stop-reason
// mapping tests assert only on the resulting callback body.
func runTaskCompletionCallback(t *testing.T, mode string, stopReason string, callbackErr error) map[string]interface{} {
	t.Helper()

	var body map[string]interface{}
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode callback body: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(controlPlane.Close)

	s := &Server{
		config:        &config.Config{HTTPCallbackTimeout: 0},
		callbackToken: "node-token",
		workspaces: map[string]*WorkspaceRuntime{
			"workspace-a": {ID: "workspace-a", CallbackToken: "workspace-token-a"},
		},
	}

	callback := s.makeTaskCompletionCallback(
		controlPlane.URL,
		"project-1",
		"task-a",
		"workspace-a",
		mode,
	)
	callback(stopReason, callbackErr)
	return body
}

func TestTaskCompletionCallbackTreatsPromptCancellationAsAwaitingFollowup(t *testing.T) {
	t.Parallel()

	body := runTaskCompletionCallback(t, config.TaskModeConversation, "cancelled", context.Canceled)

	if body["toStatus"] != nil {
		t.Fatalf("toStatus = %v, want no terminal task status", body["toStatus"])
	}
	if body["executionStep"] != "awaiting_followup" {
		t.Fatalf("executionStep = %v, want awaiting_followup", body["executionStep"])
	}
}

// TestTaskCompletionCallbackTreatsCrashRecoveryAsAwaitingFollowup is the
// server-side regression guard for the codex LoadSession recovery fix: once the
// acp layer stopped routing successful openai-codex recovery to a terminal
// "error" (resumeShouldReportTerminalErrorLocked was removed), codex recovery
// now emits the same "recovered" stop reason as claude-code. makeTaskCompletionCallback
// is agent-agnostic, so this asserts that "recovered" maps to awaiting_followup
// (task keeps running) and is NEVER turned into a terminal failure — for codex
// and claude-code alike.
func TestTaskCompletionCallbackTreatsCrashRecoveryAsAwaitingFollowup(t *testing.T) {
	t.Parallel()

	body := runTaskCompletionCallback(t, config.TaskModeTask, "recovered", nil)

	if body["toStatus"] != nil {
		t.Fatalf("toStatus = %v, want no terminal task status", body["toStatus"])
	}
	if body["executionStep"] != "awaiting_followup" {
		t.Fatalf("executionStep = %v, want awaiting_followup", body["executionStep"])
	}
}

func TestTaskCompletionCallbackTreatsConversationErrorStopReasonAsRecoverable(t *testing.T) {
	t.Parallel()

	body := runTaskCompletionCallback(
		t,
		config.TaskModeConversation,
		"error",
		errors.New("provider exhausted credits with api_key=sk-secret1234567890"),
	)

	if body["toStatus"] != nil {
		t.Fatalf("toStatus = %v, want no terminal task status", body["toStatus"])
	}
	if body["executionStep"] != "awaiting_followup" {
		t.Fatalf("executionStep = %v, want awaiting_followup", body["executionStep"])
	}
	errorMessage, ok := body["errorMessage"].(string)
	if !ok || errorMessage == "" {
		t.Fatalf("errorMessage = %v, want non-empty string", body["errorMessage"])
	}
	if strings.Contains(errorMessage, "sk-secret1234567890") {
		t.Fatalf("errorMessage leaked secret: %q", errorMessage)
	}
}

func TestTaskCompletionCallbackTreatsFatalErrorStopReasonAsTerminalFailure(t *testing.T) {
	t.Parallel()

	body := runTaskCompletionCallback(t, config.TaskModeConversation, fatalErrorStopReason, errors.New("recovery failed"))

	if body["toStatus"] != "failed" {
		t.Fatalf("toStatus = %v, want failed", body["toStatus"])
	}
	if body["executionStep"] != nil {
		t.Fatalf("executionStep = %v, want terminal failure without awaiting_followup", body["executionStep"])
	}
}

func TestTaskCompletionCallbackTreatsTaskModeErrorStopReasonAsTerminalFailure(t *testing.T) {
	t.Parallel()

	body := runTaskCompletionCallback(t, config.TaskModeTask, "error", errors.New("recovery failed"))

	if body["toStatus"] != "failed" {
		t.Fatalf("toStatus = %v, want failed", body["toStatus"])
	}
	if body["executionStep"] != nil {
		t.Fatalf("executionStep = %v, want terminal failure without awaiting_followup", body["executionStep"])
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
		callbackToken: "node-token",
		workspaces: map[string]*WorkspaceRuntime{
			"workspace-a": {ID: "workspace-a", CallbackToken: "workspace-token-a"},
			"workspace-b": {ID: "workspace-b", CallbackToken: "workspace-token-b"},
		},
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
	wantAuth := []string{"Bearer workspace-token-a", "Bearer workspace-token-b"}
	for i, req := range requests {
		if req.Authorization != wantAuth[i] {
			t.Fatalf("request %d authorization = %q, want %q", i, req.Authorization, wantAuth[i])
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
