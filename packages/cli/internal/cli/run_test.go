package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestRunPrintsHelp(t *testing.T) {
	runtime, stdout, stderr := testRuntime(t, nil, nil, nil)
	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "SAM CLI") || !strings.Contains(stdout.String(), "sam projects") {
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

func TestTasksDispatchSendsModernResourceFlags(t *testing.T) {
	doer, captured := captureJSONRequest(t, `{"taskId":"task_1","sessionId":"sess_1","status":"queued"}`, http.StatusAccepted)
	runtime, _, stderr := testRuntime(t, []string{
		"--project=project_1",
		"tasks",
		"dispatch",
		"--prompt=compile",
		"--min-vcpu=4",
		"--min-memory-gb", "16",
		"--min-disk-gb=80",
		"--exclusive-node=false",
		"--max-co-tenants=3",
	}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	resources, ok := captured.JSON["resourceRequirements"].(map[string]any)
	if !ok {
		t.Fatalf("resourceRequirements missing from %#v", captured.JSON)
	}
	if resources["minVcpu"] != 4.0 ||
		resources["minMemoryGb"] != 16.0 ||
		resources["minDiskGb"] != 80.0 ||
		resources["exclusiveNode"] != false ||
		resources["maxCoTenants"] != 3.0 {
		t.Fatalf("resource requirements = %#v", resources)
	}
}

func TestTasksDispatchResourceFlagsWithHTTPCanary(t *testing.T) {
	var requests atomic.Int64
	var captured map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/api/projects/project_1/tasks/submit" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"taskId":"task_1","sessionId":"sess_1","status":"queued"}`))
	}))
	t.Cleanup(server.Close)

	runtime, _, stderr := testRuntime(t, []string{
		"--project=project_1",
		"tasks",
		"dispatch",
		"--prompt=compile",
		"--min-vcpu", "2.5",
		"--min-memory-gb=8",
		"--min-disk-gb=0",
		"--exclusive-node",
		"--max-co-tenants=2",
	}, server.Client(), map[string]string{
		"SAM_API_URL":        server.URL,
		"SAM_SESSION_COOKIE": "cookie=value",
	})

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if requests.Load() != 1 {
		t.Fatalf("requests = %d", requests.Load())
	}
	resources, ok := captured["resourceRequirements"].(map[string]any)
	if !ok {
		t.Fatalf("resourceRequirements missing from %#v", captured)
	}
	if resources["minVcpu"] != 2.5 ||
		resources["minMemoryGb"] != 8.0 ||
		resources["minDiskGb"] != 0.0 ||
		resources["exclusiveNode"] != true ||
		resources["maxCoTenants"] != 2.0 {
		t.Fatalf("resource requirements = %#v", resources)
	}
}

func TestTasksDispatchRejectsMissingResourceFlagValuesBeforeHTTP(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{
			name: "trailing numeric flag",
			args: []string{"--project=project_1", "tasks", "dispatch", "--prompt=review", "--min-vcpu"},
			want: "--min-vcpu requires a numeric value",
		},
		{
			name: "numeric flag before another flag",
			args: []string{"--project=project_1", "tasks", "dispatch", "--prompt=review", "--min-memory-gb", "--min-disk-gb=80"},
			want: "--min-memory-gb requires a numeric value",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var requests atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests.Add(1)
				w.WriteHeader(http.StatusTeapot)
			}))
			t.Cleanup(server.Close)

			runtime, _, stderr := testRuntime(t, tt.args, server.Client(), map[string]string{
				"SAM_API_URL":        server.URL,
				"SAM_SESSION_COOKIE": "cookie=value",
			})

			code := Run(context.Background(), runtime)
			if code == 0 {
				t.Fatal("expected failure")
			}
			if requests.Load() != 0 {
				t.Fatalf("unexpected HTTP requests: %d", requests.Load())
			}
			if !strings.Contains(stderr.String(), tt.want) {
				t.Fatalf("stderr = %s", stderr.String())
			}
		})
	}
}

func TestTasksDispatchHandlesExclusiveNodeForms(t *testing.T) {
	tests := []struct {
		name        string
		args        []string
		wantMessage string
		wantValue   bool
	}{
		{
			name:        "bare flag after prompt",
			args:        []string{"--project=project_1", "tasks", "dispatch", "--prompt=compile", "--exclusive-node"},
			wantMessage: "compile",
			wantValue:   true,
		},
		{
			name:        "bare flag before positional prompt",
			args:        []string{"--project=project_1", "tasks", "dispatch", "--exclusive-node", "compile", "now"},
			wantMessage: "compile now",
			wantValue:   true,
		},
		{
			name:        "explicit false",
			args:        []string{"--project=project_1", "tasks", "dispatch", "--prompt=compile", "--exclusive-node=false"},
			wantMessage: "compile",
			wantValue:   false,
		},
		{
			name:        "space separated explicit false",
			args:        []string{"--project=project_1", "tasks", "dispatch", "--exclusive-node", "false", "compile"},
			wantMessage: "compile",
			wantValue:   false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			doer, captured := captureJSONRequest(t, `{"taskId":"task_1","sessionId":"sess_1","status":"queued"}`, http.StatusAccepted)
			runtime, _, stderr := testRuntime(t, tt.args, doer, nil)

			code := Run(context.Background(), runtime)
			if code != 0 {
				t.Fatalf("code = %d stderr=%s", code, stderr.String())
			}
			if captured.JSON["message"] != tt.wantMessage {
				t.Fatalf("message = %#v", captured.JSON["message"])
			}
			resources, ok := captured.JSON["resourceRequirements"].(map[string]any)
			if !ok {
				t.Fatalf("resourceRequirements missing from %#v", captured.JSON)
			}
			if resources["exclusiveNode"] != tt.wantValue {
				t.Fatalf("exclusiveNode = %#v", resources["exclusiveNode"])
			}
		})
	}
}

func TestTasksDispatchRejectsDuplicateExclusiveNodeBeforeHTTP(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{name: "explicit then bare", args: []string{"--exclusive-node=false", "--exclusive-node"}},
		{name: "bare then explicit", args: []string{"--exclusive-node", "--exclusive-node=false"}},
		{name: "duplicate bare", args: []string{"--exclusive-node", "--exclusive-node"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			args := []string{"--project=project_1", "tasks", "dispatch", "--prompt=compile"}
			args = append(args, tt.args...)
			runtime, _, stderr := testRuntime(t, args, noRequestDoer(t), nil)

			code := Run(context.Background(), runtime)
			if code == 0 {
				t.Fatal("expected failure")
			}
			if !strings.Contains(stderr.String(), "--exclusive-node may only be specified once") {
				t.Fatalf("stderr = %s", stderr.String())
			}
		})
	}
}

func TestTasksDispatchKeepsDeprecatedVMSizeWithModernFlags(t *testing.T) {
	doer, captured := captureJSONRequest(t, `{"taskId":"task_1","sessionId":"sess_1","status":"queued"}`, http.StatusAccepted)
	runtime, _, stderr := testRuntime(t, []string{
		"--project=project_1",
		"tasks",
		"dispatch",
		"--prompt=compile",
		"--vm-size=small",
		"--min-vcpu=8",
	}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	resources := captured.JSON["resourceRequirements"].(map[string]any)
	if captured.JSON["vmSize"] != "small" || resources["minVcpu"] != 8.0 {
		t.Fatalf("payload = %#v", captured.JSON)
	}
	if !strings.Contains(stderr.String(), "--vm-size is deprecated") {
		t.Fatalf("stderr missing deprecation warning: %s", stderr.String())
	}
}

func TestTasksDispatchRejectsMalformedResourceFlags(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{name: "zero vcpu", args: []string{"--min-vcpu=0"}, want: "--min-vcpu must be a finite positive number"},
		{name: "negative", args: []string{"--min-vcpu=-1"}, want: "--min-vcpu must be a finite positive number"},
		{name: "nan", args: []string{"--min-memory-gb=NaN"}, want: "--min-memory-gb must be a finite positive number"},
		{name: "infinity", args: []string{"--min-disk-gb=+Inf"}, want: "--min-disk-gb must be a finite non-negative number"},
		{name: "bool", args: []string{"--exclusive-node=maybe"}, want: "--exclusive-node must be true or false"},
		{name: "zero co-tenants", args: []string{"--max-co-tenants=0"}, want: "--max-co-tenants must be a positive safe integer"},
		{name: "fractional co-tenants", args: []string{"--max-co-tenants=1.5"}, want: "--max-co-tenants must be a positive safe integer"},
		{name: "unsafe co-tenants", args: []string{"--max-co-tenants=9007199254740992"}, want: "--max-co-tenants must be a positive safe integer"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			args := []string{"--project=project_1", "tasks", "dispatch", "--prompt=compile"}
			args = append(args, tt.args...)
			runtime, _, stderr := testRuntime(t, args, nil, nil)

			code := Run(context.Background(), runtime)
			if code == 0 {
				t.Fatal("expected failure")
			}
			if !strings.Contains(stderr.String(), tt.want) {
				t.Fatalf("stderr = %s", stderr.String())
			}
		})
	}
}

func TestChatNewDeprecatedVMSizeWarningUsesStderrWithJSONStdout(t *testing.T) {
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/api/projects/01ABCDEFGHIJKLMNOPQRSTUVWX/tasks/submit" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"taskId":"task_1","sessionId":"sess_1","status":"queued"}`))
	}))
	t.Cleanup(server.Close)

	env := tempConfigEnv(t)
	if _, err := SaveConfig(env, CLIConfig{
		APIURL:            server.URL,
		SessionCookie:     "cookie=value",
		ActiveProjectID:   "01ABCDEFGHIJKLMNOPQRSTUVWX",
		ActiveProjectName: "Project 1",
	}); err != nil {
		t.Fatal(err)
	}
	runtime, stdout, stderr := testRuntime(t, []string{"chat", "new", "review", "--vm-size=small", "--json"}, server.Client(), env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if requests.Load() != 1 {
		t.Fatalf("requests = %d", requests.Load())
	}
	if !strings.Contains(stderr.String(), "--vm-size is deprecated") {
		t.Fatalf("stderr missing deprecation warning: %s", stderr.String())
	}
	var response SubmitTaskResponse
	if err := json.Unmarshal(stdout.Bytes(), &response); err != nil {
		t.Fatalf("stdout is not valid JSON: %v\n%s", err, stdout.String())
	}
	if response.TaskID != "task_1" {
		t.Fatalf("response = %#v", response)
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

func TestChatNewSubmitsConversationTask(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "project_1", "My Project")
	doer, captured := captureJSONRequest(t, `{"taskId":"task_1","sessionId":"sess_1","status":"queued"}`, http.StatusAccepted)
	runtime, stdout, stderr := testRuntime(t, []string{
		"chat",
		"new",
		"Plan",
		"the",
		"release",
	}, doer, env.values)

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

func TestChatViewShowsMessages(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "project_1", "My Project")
	doer, captured := captureJSONRequest(t, `{"session":{"id":"session_1","topic":"Demo","status":"active","messageCount":2},"messages":[{"id":"msg_1","role":"user","content":"Hello","createdAt":1780099200000},{"id":"msg_2","role":"assistant","content":"Hi there","createdAt":1780099200000}],"hasMore":false,"state":null}`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"chat", "session_1"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.URL != "https://api.example.com/api/projects/project_1/sessions/session_1" {
		t.Fatalf("path = %s", captured.URL)
	}
	if !strings.Contains(stdout.String(), "[user]") || !strings.Contains(stdout.String(), "Hello") {
		t.Fatalf("stdout = %s", stdout.String())
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

func TestAuthLoginTokenExchangesPATAndSavesConfig(t *testing.T) {
	env := tempConfigEnv(t)
	doer, captured := captureJSONRequest(t, `{"success":true,"sessionCookie":"better-auth.session_token=from-pat","user":{"email":"dev@example.com","name":"Dev"}}`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"auth", "login", "--api-url", "https://api.example.com", "--token", "sam_pat_secret"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.URL != "https://api.example.com/api/auth/token-login" || captured.JSON["token"] != "sam_pat_secret" {
		t.Fatalf("unexpected token-login request: %s %#v", captured.URL, captured.JSON)
	}
	if strings.Contains(stdout.String(), "sam_pat_secret") || strings.Contains(stdout.String(), "from-pat") {
		t.Fatalf("stdout leaked secret: %s", stdout.String())
	}
	if !strings.Contains(stdout.String(), "Authenticated as Dev <dev@example.com>") {
		t.Fatalf("stdout = %s", stdout.String())
	}
	config, err := LoadConfig(env)
	if err != nil {
		t.Fatal(err)
	}
	if config == nil || config.SessionCookie != "better-auth.session_token=from-pat" {
		t.Fatalf("config = %#v", config)
	}
}

func TestAuthLoginTokenUsesDefaultAPIURLWhenNotSpecified(t *testing.T) {
	env := tempConfigEnv(t)
	doer, captured := captureJSONRequest(t, `{"success":true,"sessionCookie":"better-auth.session_token=from-pat","user":{"email":"dev@example.com"}}`, http.StatusOK)
	runtime, _, stderr := testRuntime(t, []string{"auth", "login", "--token", "sam_pat_secret"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.URL != defaultAPIURL+"/api/auth/token-login" {
		t.Fatalf("expected default API URL, got: %s", captured.URL)
	}
}

func TestAuthenticatedClientFromEnvToken(t *testing.T) {
	var requests []string
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		requests = append(requests, req.URL.String())
		if req.URL.Path == "/api/auth/token-login" {
			return jsonResponse(`{"success":true,"sessionCookie":"better-auth.session_token=env-cookie","user":{"email":"env@example.com"}}`, http.StatusOK), nil
		}
		if got := req.Header.Get("Cookie"); got != "better-auth.session_token=env-cookie" {
			t.Fatalf("Cookie header = %q", got)
		}
		return jsonResponse(`{"id":"task_1","status":"queued","updatedAt":"now"}`, http.StatusOK), nil
	})
	runtime, _, stderr := testRuntime(t, []string{"--project", "project_1", "task", "status", "task_1"}, doer, map[string]string{
		"SAM_API_URL":   "https://api.example.com",
		"SAM_API_TOKEN": "sam_pat_env",
	})

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if len(requests) != 2 || requests[0] != "https://api.example.com/api/auth/token-login" {
		t.Fatalf("requests = %#v", requests)
	}
}

func TestDeviceFlowUsesDefaultAPIURLWhenNotSpecified(t *testing.T) {
	env := tempConfigEnv(t)
	var requests []string
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		requests = append(requests, req.URL.String())
		switch req.URL.Path {
		case "/api/auth/device/code":
			return jsonResponse(`{"deviceCode":"device-1","userCode":"ABCD-1234","verificationUriComplete":"https://app.example.com/device?code=ABCD-1234","expiresIn":30,"interval":1}`, http.StatusOK), nil
		case "/api/auth/device/token":
			return jsonResponse(`{"success":true,"sessionCookie":"better-auth.session_token=device-cookie","user":{"email":"device@example.com"}}`, http.StatusOK), nil
		default:
			return jsonResponse(`{"error":"not_found","message":"not found"}`, http.StatusNotFound), nil
		}
	})
	runtime, _, stderr := testRuntime(t, []string{"auth", "login"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if len(requests) < 1 || requests[0] != defaultAPIURL+"/api/auth/device/code" {
		t.Fatalf("expected default API URL, got requests: %#v", requests)
	}
}

func TestDeviceFlowHappyPath(t *testing.T) {
	env := tempConfigEnv(t)
	var requests []string
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		requests = append(requests, req.URL.String())
		switch req.URL.Path {
		case "/api/auth/device/code":
			return jsonResponse(`{"deviceCode":"device-1","userCode":"ABCD-1234","verificationUriComplete":"https://app.example.com/device?code=ABCD-1234","expiresIn":30,"interval":1}`, http.StatusOK), nil
		case "/api/auth/device/token":
			return jsonResponse(`{"success":true,"sessionCookie":"better-auth.session_token=device-cookie","user":{"email":"device@example.com"}}`, http.StatusOK), nil
		default:
			return jsonResponse(`{"error":"not_found","message":"not found"}`, http.StatusNotFound), nil
		}
	})
	runtime, stdout, stderr := testRuntime(t, []string{"auth", "login", "--api-url", "https://api.example.com"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "ABCD-1234") || !strings.Contains(stdout.String(), "Authenticated as device@example.com") {
		t.Fatalf("stdout = %s", stdout.String())
	}
	if len(requests) != 2 || requests[0] != "https://api.example.com/api/auth/device/code" || requests[1] != "https://api.example.com/api/auth/device/token" {
		t.Fatalf("requests = %#v", requests)
	}
}
