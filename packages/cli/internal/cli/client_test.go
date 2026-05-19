package cli

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

func TestSubmitTaskBuildsAuthenticatedRequest(t *testing.T) {
	var captured *http.Request
	var payload map[string]any
	client := NewAPIClient(CLIConfig{
		APIURL:        "https://api.example.com",
		SessionCookie: "better-auth.session_token=secret",
	}, roundTripFunc(func(req *http.Request) (*http.Response, error) {
		captured = req
		content, err := io.ReadAll(req.Body)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(content, &payload); err != nil {
			t.Fatal(err)
		}
		return jsonResponse(`{"taskId":"task_1","sessionId":"sess_1","branchName":"sam/demo","status":"queued"}`, http.StatusAccepted), nil
	}))

	response, err := client.SubmitTask(context.Background(), "project_1", "Build CLI", TaskSubmitOptions{
		Mode:      "task",
		VMSize:    "small",
		Workspace: "lightweight",
	})
	if err != nil {
		t.Fatal(err)
	}
	if response.TaskID != "task_1" {
		t.Fatalf("task id = %q", response.TaskID)
	}
	if captured.URL.String() != "https://api.example.com/api/projects/project_1/tasks/submit" {
		t.Fatalf("url = %s", captured.URL.String())
	}
	if captured.Header.Get("Cookie") != "better-auth.session_token=secret" {
		t.Fatal("missing auth cookie")
	}
	if payload["message"] != "Build CLI" || payload["taskMode"] != "task" || payload["workspaceProfile"] != "lightweight" {
		t.Fatalf("unexpected payload: %#v", payload)
	}
}

func TestAPIErrorDoesNotExposeCookie(t *testing.T) {
	client := NewAPIClient(CLIConfig{
		APIURL:        "https://api.example.com",
		SessionCookie: "secret-cookie",
	}, roundTripFunc(func(*http.Request) (*http.Response, error) {
		return jsonResponse(`{"error":"AUTHENTICATION_REQUIRED","message":"Authentication required"}`, http.StatusUnauthorized), nil
	}))

	_, err := client.GetTaskStatus(context.Background(), "project_1", "task_1")
	if err == nil {
		t.Fatal("expected error")
	}
	if err.Error() != "AUTHENTICATION_REQUIRED: Authentication required" {
		t.Fatalf("error = %q", err.Error())
	}
}
