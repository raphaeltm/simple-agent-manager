package cli

import (
	"context"
	"io"
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

func TestAPIInvalidJSONErrorRedactsSensitiveQueryValues(t *testing.T) {
	err := doJSON(
		context.Background(),
		roundTripFunc(func(*http.Request) (*http.Response, error) {
			return jsonResponse(`not-json`, http.StatusOK), nil
		}),
		http.MethodGet,
		"https://api.example.com/api/demo?token=secret-token&cursor=abc",
		"cookie=value",
		nil,
		&map[string]any{},
	)
	if err == nil {
		t.Fatal("expected invalid JSON error")
	}
	message := err.Error()
	if strings.Contains(message, "secret-token") || strings.Contains(message, "cookie=value") {
		t.Fatalf("error leaked secret: %q", message)
	}
	if !strings.Contains(message, "token=REDACTED") || !strings.Contains(message, "cursor=abc") {
		t.Fatalf("error missing safe query context: %q", message)
	}
}

func TestDoJSONRejectsOversizedSuccessResponse(t *testing.T) {
	err := doJSON(
		context.Background(),
		roundTripFunc(func(*http.Request) (*http.Response, error) {
			return jsonResponse(strings.Repeat("a", int(defaultMaxAPIResponseBodyBytes)+1), http.StatusOK), nil
		}),
		http.MethodGet,
		"https://api.example.com/api/projects",
		"cookie=value",
		nil,
		&map[string]any{},
	)
	if err == nil {
		t.Fatal("expected oversized response error")
	}
	apiErr, ok := err.(APIError)
	if !ok {
		t.Fatalf("error type = %T, want APIError", err)
	}
	if apiErr.Code != "RESPONSE_TOO_LARGE" {
		t.Fatalf("code = %q", apiErr.Code)
	}
	if strings.Contains(err.Error(), strings.Repeat("a", 64)) {
		t.Fatalf("error included oversized response content: %q", err.Error())
	}
}

func TestDoJSONCapsOversizedErrorResponseBodyRead(t *testing.T) {
	body := &countingBody{remaining: defaultMaxAPIResponseBodyBytes + 10_000}
	client := NewAPIClient(CLIConfig{
		APIURL:        "https://api.example.com",
		SessionCookie: "cookie=value",
	}, roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusInternalServerError,
			Header:     make(http.Header),
			Body:       body,
		}, nil
	}))

	_, err := client.GetTaskStatus(context.Background(), "project_1", "task_1")
	if err == nil {
		t.Fatal("expected API error")
	}
	if body.bytesRead != defaultMaxAPIResponseBodyBytes+1 {
		t.Fatalf("read %d bytes, want %d", body.bytesRead, defaultMaxAPIResponseBodyBytes+1)
	}
	if !body.closed {
		t.Fatal("response body was not closed")
	}
	apiErr, ok := err.(APIError)
	if !ok {
		t.Fatalf("error type = %T, want APIError", err)
	}
	if apiErr.Code != "HTTP_ERROR" {
		t.Fatalf("code = %q", apiErr.Code)
	}
	if len(apiErr.Message) != int(defaultMaxAPIResponseBodyBytes) {
		t.Fatalf("message length = %d, want %d", len(apiErr.Message), defaultMaxAPIResponseBodyBytes)
	}
}

func TestAPIClientUsesConfiguredResponseBodyLimit(t *testing.T) {
	body := &countingBody{remaining: 128}
	client := NewAPIClient(CLIConfig{
		APIURL:              "https://api.example.com",
		SessionCookie:       "cookie=value",
		MaxAPIResponseBytes: 32,
	}, roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusBadGateway,
			Header:     make(http.Header),
			Body:       body,
		}, nil
	}))

	_, err := client.GetTaskStatus(context.Background(), "project_1", "task_1")
	if err == nil {
		t.Fatal("expected API error")
	}
	if body.bytesRead != 33 {
		t.Fatalf("read %d bytes, want 33", body.bytesRead)
	}
}

type countingBody struct {
	remaining int64
	bytesRead int64
	closed    bool
}

func (b *countingBody) Read(p []byte) (int, error) {
	if b.remaining == 0 {
		return 0, io.EOF
	}
	if int64(len(p)) > b.remaining {
		p = p[:b.remaining]
	}
	for i := range p {
		p[i] = 'x'
	}
	n := len(p)
	b.remaining -= int64(n)
	b.bytesRead += int64(n)
	return n, nil
}

func (b *countingBody) Close() error {
	b.closed = true
	return nil
}
