package cli

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestSubmitTaskBuildsAuthenticatedRequest(t *testing.T) {
	doer, captured := captureJSONRequest(t, `{"taskId":"task_1","sessionId":"sess_1","branchName":"sam/demo","status":"queued"}`, http.StatusAccepted)
	client := NewAPIClient(CLIConfig{
		APIURL:        "https://api.example.com",
		SessionCookie: "better-auth.session_token=secret",
	}, doer)

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
	if captured.URL != "https://api.example.com/api/projects/project_1/tasks/submit" {
		t.Fatalf("url = %s", captured.URL)
	}
	if captured.Headers.Get("Cookie") != "better-auth.session_token=secret" {
		t.Fatal("missing auth cookie")
	}
	if captured.JSON["message"] != "Build CLI" || captured.JSON["taskMode"] != "task" || captured.JSON["workspaceProfile"] != "lightweight" {
		t.Fatalf("unexpected payload: %#v", captured.JSON)
	}
}

func TestProjectAPIPathEscapesEveryDynamicSegment(t *testing.T) {
	doer, captured := captureJSONRequest(t, `{"success":true}`, http.StatusOK)
	client := NewAPIClient(CLIConfig{
		APIURL:        "https://api.example.com",
		SessionCookie: "cookie=value",
	}, doer)

	_, err := client.SendPrompt(context.Background(), "project with/slash", "session/with space", "hello")
	if err != nil {
		t.Fatal(err)
	}

	want := "https://api.example.com/api/projects/project%20with%2Fslash/sessions/session%2Fwith%20space/prompt"
	if captured.URL != want {
		t.Fatalf("url = %s, want %s", captured.URL, want)
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

func TestAPIErrorFallsBackToStatusWhenBodyIsEmpty(t *testing.T) {
	client := NewAPIClient(CLIConfig{
		APIURL:        "https://api.example.com",
		SessionCookie: "cookie=value",
	}, roundTripFunc(func(*http.Request) (*http.Response, error) {
		return jsonResponse(``, http.StatusBadGateway), nil
	}))

	_, err := client.GetTaskStatus(context.Background(), "project_1", "task_1")
	if err == nil {
		t.Fatal("expected HTTP error")
	}
	if err.Error() != "HTTP_ERROR: SAM API request failed with 502" {
		t.Fatalf("error = %q", err.Error())
	}
}

func TestAPIInvalidJSONErrorIsActionableAndRedacted(t *testing.T) {
	client := NewAPIClient(CLIConfig{
		APIURL:        "https://api.example.com",
		SessionCookie: "better-auth.session_token=secret",
	}, roundTripFunc(func(*http.Request) (*http.Response, error) {
		return jsonResponse(`{this is not json`, http.StatusOK), nil
	}))

	_, err := client.GetTaskStatus(context.Background(), "project_1", "task_1")
	if err == nil {
		t.Fatal("expected invalid JSON error")
	}
	if !strings.Contains(err.Error(), "INVALID_JSON") {
		t.Fatalf("error = %q", err.Error())
	}
	if strings.Contains(err.Error(), "secret") {
		t.Fatalf("error leaked cookie: %q", err.Error())
	}
}
