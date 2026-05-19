package cli

import (
	"bytes"
	"context"
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

func TestAuthStatusReportsSavedConfigWithoutLeakingCookie(t *testing.T) {
	env := tempConfigEnv(t)
	if _, err := SaveConfig(env, CLIConfig{
		APIURL:        "https://api.example.com/",
		SessionCookie: "better-auth.session_token=secret",
	}); err != nil {
		t.Fatal(err)
	}
	runtime, stdout, stderr := testRuntime(t, []string{"auth", "status", "--json"}, nil, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	output := stdout.String()
	if !strings.Contains(output, `"authenticated": true`) || !strings.Contains(output, `"apiUrl": "https://api.example.com"`) {
		t.Fatalf("unexpected auth status output: %s", output)
	}
	if strings.Contains(output, "secret") {
		t.Fatalf("auth status leaked cookie: %s", output)
	}
}

func TestAuthStatusReturnsOneWhenNoConfigExists(t *testing.T) {
	env := tempConfigEnv(t)
	runtime, stdout, stderr := testRuntime(t, []string{"auth", "status"}, nil, env.values)

	code := Run(context.Background(), runtime)
	if code != 1 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "Not authenticated") {
		t.Fatalf("stdout = %s", stdout.String())
	}
}

func TestTasksDispatchUsesGlobalProjectAndPrompt(t *testing.T) {
	doer, captured := captureJSONRequest(t, `{"taskId":"task_1","sessionId":"sess_1","status":"queued"}`, http.StatusAccepted)
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
	if captured.URL != "https://api.example.com/api/projects/project_1/tasks/submit" {
		t.Fatalf("path = %s", captured.URL)
	}
	if captured.JSON["message"] != "manage idea 123" || captured.JSON["agentType"] != "sam" {
		t.Fatalf("unexpected payload: %#v", captured.JSON)
	}
	if captured.JSON["taskMode"] != "task" || captured.JSON["workspaceProfile"] != "lightweight" {
		t.Fatalf("unexpected task options: %#v", captured.JSON)
	}
}

func TestTaskSubmitUsesPromptFlag(t *testing.T) {
	doer, captured := captureJSONRequest(t, `{"taskId":"task_1","sessionId":"sess_1","status":"queued"}`, http.StatusAccepted)
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
	if captured.JSON["message"] != "manage idea 123" {
		t.Fatalf("unexpected payload: %#v", captured.JSON)
	}
}

func TestTaskStatusPrintsStructuredStatus(t *testing.T) {
	outputBranch := "sam/feature"
	outputPRURL := "https://github.com/org/repo/pull/1"
	response := `{
		"id":"task_1",
		"title":"Ship CLI",
		"status":"completed",
		"executionStep":"done",
		"taskMode":"task",
		"outputBranch":"` + outputBranch + `",
		"outputPrUrl":"` + outputPRURL + `",
		"updatedAt":"2026-05-19T00:00:00Z"
	}`
	doer, captured := captureJSONRequest(t, response, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{
		"--project=project_1",
		"task",
		"status",
		"task_1",
	}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.Method != http.MethodGet || captured.URL != "https://api.example.com/api/projects/project_1/tasks/task_1" {
		t.Fatalf("unexpected request: %s %s", captured.Method, captured.URL)
	}
	for _, expected := range []string{
		"id: task_1",
		"title: Ship CLI",
		"status: completed",
		"outputBranch: " + outputBranch,
		"outputPrUrl: " + outputPRURL,
	} {
		if !strings.Contains(stdout.String(), expected) {
			t.Fatalf("status output missing %q:\n%s", expected, stdout.String())
		}
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

func TestChatWithoutSessionSubmitsConversationTask(t *testing.T) {
	doer, captured := captureJSONRequest(t, `{"taskId":"task_1","sessionId":"sess_1","status":"queued"}`, http.StatusAccepted)
	runtime, stdout, stderr := testRuntime(t, []string{
		"--project=project_1",
		"chat",
		"Plan",
		"the",
		"release",
	}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.URL != "https://api.example.com/api/projects/project_1/tasks/submit" {
		t.Fatalf("path = %s", captured.URL)
	}
	if captured.JSON["message"] != "Plan the release" || captured.JSON["taskMode"] != "conversation" {
		t.Fatalf("payload = %#v", captured.JSON)
	}
	if !strings.Contains(stdout.String(), "Task submitted") {
		t.Fatalf("stdout = %s", stdout.String())
	}
}

func TestChatWithSessionSendsPrompt(t *testing.T) {
	doer, captured := captureJSONRequest(t, `{"success":true}`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"--project", "project_1", "chat", "--session", "session_1", "Follow up", "--json"}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.URL != "https://api.example.com/api/projects/project_1/sessions/session_1/prompt" {
		t.Fatalf("path = %s", captured.URL)
	}
	if captured.JSON["content"] != "Follow up" {
		t.Fatalf("payload = %#v", captured.JSON)
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

func TestRunnerDoctorCommandPrintsHostReadiness(t *testing.T) {
	runtime, stdout, stderr := testRuntime(t, []string{"runner", "doctor"}, nil, nil)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	output := stdout.String()
	for _, expected := range []string{"SAM runner doctor", "Docker daemon: ok", "systemd: ok", "vm-agent: ok"} {
		if !strings.Contains(output, expected) {
			t.Fatalf("runner doctor output missing %q:\n%s", expected, output)
		}
	}
}
