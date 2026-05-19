package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestRunPrintsHelp(t *testing.T) {
	runtime, stdout, stderr := testRuntime(t, nil, nil, nil)
	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "SAM CLI") || !strings.Contains(stdout.String(), "tasks dispatch") {
		t.Fatalf("help output missing expected text: %s", stdout.String())
	}
}

func TestAuthLoginReadsCookieFromStdin(t *testing.T) {
	env := tempConfigEnv(t)
	runtime, stdout, stderr := testRuntime(t, []string{"auth", "login", "--api-url", "https://api.example.com", "--session-cookie-stdin"}, nil, env.values)
	runtime.Stdin = bytes.NewBufferString("better-auth.session_token=secret\n")

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if strings.Contains(stdout.String(), "secret") {
		t.Fatalf("stdout leaked secret: %s", stdout.String())
	}
}

func TestTasksDispatchUsesGlobalProjectAndPrompt(t *testing.T) {
	var payload map[string]any
	var path string
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		path = req.URL.String()
		content, err := io.ReadAll(req.Body)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(content, &payload); err != nil {
			t.Fatal(err)
		}
		return jsonResponse(`{"taskId":"task_1","sessionId":"sess_1","status":"queued"}`, http.StatusAccepted), nil
	})
	runtime, _, stderr := testRuntime(t, []string{
		"--project=project_1",
		"tasks",
		"dispatch",
		"--agent=sam",
		"--mode=task",
		"--workspace=lightweight",
		"--prompt=manage idea 123",
	}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if path != "https://api.example.com/api/projects/project_1/tasks/submit" {
		t.Fatalf("path = %s", path)
	}
	if payload["message"] != "manage idea 123" || payload["agentType"] != "sam" {
		t.Fatalf("unexpected payload: %#v", payload)
	}
	if payload["taskMode"] != "task" || payload["workspaceProfile"] != "lightweight" {
		t.Fatalf("unexpected task options: %#v", payload)
	}
}

func TestTaskSubmitUsesPromptFlag(t *testing.T) {
	var payload map[string]any
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		content, err := io.ReadAll(req.Body)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(content, &payload); err != nil {
			t.Fatal(err)
		}
		return jsonResponse(`{"taskId":"task_1","sessionId":"sess_1","status":"queued"}`, http.StatusAccepted), nil
	})
	runtime, _, stderr := testRuntime(t, []string{
		"--project=project_1",
		"task",
		"submit",
		"--prompt=manage idea 123",
	}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if payload["message"] != "manage idea 123" {
		t.Fatalf("unexpected payload: %#v", payload)
	}
}

func TestModelFlagFailsUntilAPIContractExists(t *testing.T) {
	runtime, _, stderr := testRuntime(t, []string{
		"--project=project_1",
		"tasks",
		"dispatch",
		"--model=gemma-4",
		"--prompt=manage idea 123",
	}, nil, nil)

	code := Run(context.Background(), runtime)
	if code == 0 {
		t.Fatal("expected failure")
	}
	if !strings.Contains(stderr.String(), "current task submit API does not accept") {
		t.Fatalf("stderr = %s", stderr.String())
	}
}

func TestChatWithSessionSendsPrompt(t *testing.T) {
	var path string
	var payload map[string]any
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		path = req.URL.String()
		content, err := io.ReadAll(req.Body)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(content, &payload); err != nil {
			t.Fatal(err)
		}
		return jsonResponse(`{"success":true}`, http.StatusOK), nil
	})
	runtime, stdout, stderr := testRuntime(t, []string{"--project", "project_1", "chat", "--session", "session_1", "Follow up", "--json"}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if path != "https://api.example.com/api/projects/project_1/sessions/session_1/prompt" {
		t.Fatalf("path = %s", path)
	}
	if payload["content"] != "Follow up" {
		t.Fatalf("payload = %#v", payload)
	}
	if !strings.Contains(stdout.String(), `"success": true`) {
		t.Fatalf("json output = %s", stdout.String())
	}
}

func TestPlannedCommandsFailClearly(t *testing.T) {
	runtime, _, stderr := testRuntime(t, []string{"runner", "register"}, nil, nil)
	code := Run(context.Background(), runtime)
	if code == 0 {
		t.Fatal("expected failure")
	}
	if !strings.Contains(stderr.String(), "planned but not implemented yet") {
		t.Fatalf("stderr = %s", stderr.String())
	}
}
