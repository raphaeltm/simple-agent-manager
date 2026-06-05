package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestListProjectsShowsTable(t *testing.T) {
	doer, captured := captureJSONRequest(t, `{"projects":[{"id":"01ABC","name":"My App","repository":"github.com/org/app","activeSessionCount":3},{"id":"01DEF","name":"Other","repository":"","activeSessionCount":0}]}`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"projects"}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.URL != "https://api.example.com/api/projects" {
		t.Fatalf("path = %s", captured.URL)
	}
	output := stdout.String()
	if !strings.Contains(output, "My App") || !strings.Contains(output, "Other") {
		t.Fatalf("stdout missing project names: %s", output)
	}
	if !strings.Contains(output, "NAME") {
		t.Fatalf("stdout missing table headers: %s", output)
	}
}

func TestListProjectsEmptyState(t *testing.T) {
	doer, _ := captureJSONRequest(t, `{"projects":[]}`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"projects"}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "No projects found") {
		t.Fatalf("stdout = %s", stdout.String())
	}
}

func TestListProjectsJSON(t *testing.T) {
	doer, _ := captureJSONRequest(t, `{"projects":[{"id":"01ABC","name":"My App"}]}`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"projects", "--json"}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), `"name": "My App"`) {
		t.Fatalf("json output = %s", stdout.String())
	}
}

func TestProjectUseWithArg(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "", "")
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(`{"projects":[{"id":"01ABCDEFGHIJKLMNOPQRSTUVWX","name":"My App"}]}`, http.StatusOK), nil
	})
	runtime, stdout, stderr := testRuntime(t, []string{"project", "use", "My App"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "Active project set to My App") {
		t.Fatalf("stdout = %s", stdout.String())
	}
	cfg, err := LoadConfig(env)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ActiveProjectID != "01ABCDEFGHIJKLMNOPQRSTUVWX" {
		t.Fatalf("activeProjectId = %s", cfg.ActiveProjectID)
	}
}

func TestProjectUseWithPicker(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "", "")
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(`{"projects":[{"id":"01ABCDEFGHIJKLMNOPQRSTUVWX","name":"First"},{"id":"01ZYXWVUTSRQPONMLKJIHGFEDC","name":"Second"}]}`, http.StatusOK), nil
	})
	runtime, stdout, stderr := testRuntime(t, []string{"project", "use"}, doer, env.values)
	runtime.Stdin = bytes.NewBufferString("2\n")

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "Active project set to Second") {
		t.Fatalf("stdout = %s", stdout.String())
	}
}

func TestProjectDetailShowsInfo(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "project_1", "My Project")
	doer, captured := captureJSONRequest(t, `{"id":"project_1","name":"My Project","repository":"github.com/org/repo","defaultBranch":"main","status":"active","activeSessionCount":2,"activeWorkspaceCount":1}`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"project"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.URL != "https://api.example.com/api/projects/project_1" {
		t.Fatalf("path = %s", captured.URL)
	}
	output := stdout.String()
	if !strings.Contains(output, "My Project") || !strings.Contains(output, "github.com/org/repo") {
		t.Fatalf("stdout = %s", output)
	}
}

func TestProjectDetailWithOverride(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "default_proj", "Default")
	doer, captured := captureJSONRequest(t, `{"id":"01ABCDEFGHIJKLMNOPQRSTUVWX","name":"Override"}`, http.StatusOK)
	runtime, _, stderr := testRuntime(t, []string{"--project", "01ABCDEFGHIJKLMNOPQRSTUVWX", "project"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.URL != "https://api.example.com/api/projects/01ABCDEFGHIJKLMNOPQRSTUVWX" {
		t.Fatalf("path = %s", captured.URL)
	}
}

func TestStatusShowsDashboard(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "project_1", "My Project")
	callCount := 0
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		callCount++
		if strings.HasSuffix(req.URL.Path, "/sessions") {
			return jsonResponse(`{"sessions":[{"id":"sess_1","topic":"Fix bugs","status":"active","messageCount":5}]}`, http.StatusOK), nil
		}
		return jsonResponse(`{"id":"project_1","name":"My Project","repository":"github.com/org/repo","activeSessionCount":1,"activeWorkspaceCount":0}`, http.StatusOK), nil
	})
	runtime, stdout, stderr := testRuntime(t, []string{"status"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	output := stdout.String()
	if !strings.Contains(output, "My Project") || !strings.Contains(output, "Fix bugs") {
		t.Fatalf("stdout = %s", output)
	}
}

func TestChatListShowsTable(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "project_1", "My Project")
	doer, captured := captureJSONRequest(t, `{"sessions":[{"id":"sess_1","topic":"Fix bugs","status":"active","messageCount":5},{"id":"sess_2","topic":"Deploy","status":"completed","messageCount":12}]}`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"chat"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.URL != "https://api.example.com/api/projects/project_1/sessions" {
		t.Fatalf("path = %s", captured.URL)
	}
	output := stdout.String()
	if !strings.Contains(output, "Fix bugs") || !strings.Contains(output, "Deploy") {
		t.Fatalf("stdout = %s", output)
	}
}

func TestChatNewRequiresMessage(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "project_1", "My Project")
	runtime, _, stderr := testRuntime(t, []string{"chat", "new"}, nil, env.values)

	code := Run(context.Background(), runtime)
	if code != 1 {
		t.Fatalf("expected failure, got code %d", code)
	}
	if !strings.Contains(stderr.String(), "chat new requires a message") {
		t.Fatalf("stderr = %s", stderr.String())
	}
}

func TestChatNewWithPromptFlag(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "project_1", "My Project")
	doer, captured := captureJSONRequest(t, `{"taskId":"task_1","sessionId":"sess_1","status":"queued"}`, http.StatusAccepted)
	runtime, _, stderr := testRuntime(t, []string{"chat", "new", "--prompt", "Fix the bug"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.JSON["message"] != "Fix the bug" || captured.JSON["taskMode"] != "conversation" {
		t.Fatalf("payload = %#v", captured.JSON)
	}
}

func TestIdeasShowsTable(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "project_1", "My Project")
	doer, captured := captureJSONRequest(t, `{"tasks":[{"id":"idea_1","title":"Add dark mode","priority":1},{"id":"idea_2","title":"Fix login","priority":2}]}`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"ideas"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.URL != "https://api.example.com/api/projects/project_1/tasks?status=draft" {
		t.Fatalf("path = %s", captured.URL)
	}
	output := stdout.String()
	if !strings.Contains(output, "Add dark mode") || !strings.Contains(output, "Fix login") {
		t.Fatalf("stdout = %s", output)
	}
}

func TestLibraryShowsTable(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "project_1", "My Project")
	doer, captured := captureJSONRequest(t, `{"files":[{"id":"file_1","filename":"spec.md","directory":"/","sizeBytes":1024,"uploadSource":"user","createdAt":"2026-05-30T00:00:00Z"}],"cursor":null,"total":1}`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"library"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.URL != "https://api.example.com/api/projects/project_1/library" {
		t.Fatalf("path = %s", captured.URL)
	}
	if !strings.Contains(stdout.String(), "spec.md") || !strings.Contains(stdout.String(), "1.0 KB") || !strings.Contains(stdout.String(), "use --recursive") {
		t.Fatalf("stdout = %s", stdout.String())
	}
}

func TestLibraryRecursiveRequestsAllFiles(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "project_1", "My Project")
	doer, captured := captureJSONRequest(t, `{"files":[{"id":"file_1","filename":"spec.md","directory":"/docs/","sizeBytes":2048,"uploadSource":"agent","createdAt":"2026-05-30T00:00:00Z"}],"cursor":null,"total":1}`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"library", "--recursive"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.URL != "https://api.example.com/api/projects/project_1/library?recursive=true" {
		t.Fatalf("path = %s", captured.URL)
	}
	if !strings.Contains(stdout.String(), "/docs/spec.md") || strings.Contains(stdout.String(), "use --recursive") {
		t.Fatalf("stdout = %s", stdout.String())
	}
}

func TestContextShowsTable(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "project_1", "My Project")
	doer, captured := captureJSONRequest(t, `{"entities":[{"id":"ent_1","name":"UserPrefs","entityType":"context","observationCount":5,"updatedAt":1780099200000}]}`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"context"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.URL != "https://api.example.com/api/projects/project_1/knowledge" {
		t.Fatalf("path = %s", captured.URL)
	}
	if !strings.Contains(stdout.String(), "UserPrefs") {
		t.Fatalf("stdout = %s", stdout.String())
	}
}

func TestNotificationsShowsTable(t *testing.T) {
	doer, captured := captureJSONRequest(t, `{"notifications":[{"id":"notif_1","type":"task_complete","title":"Task done","readAt":null,"createdAt":"2026-05-30T00:00:00Z"}],"unreadCount":1,"nextCursor":null}`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"notifications"}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.URL != "https://api.example.com/api/notifications" {
		t.Fatalf("path = %s", captured.URL)
	}
	if !strings.Contains(stdout.String(), "Task done") || !strings.Contains(stdout.String(), "no") {
		t.Fatalf("stdout = %s", stdout.String())
	}
}

func TestTriggersShowsTable(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "project_1", "My Project")
	doer, captured := captureJSONRequest(t, `{"triggers":[{"id":"trig_1","name":"Daily check","sourceType":"cron","cronExpression":"0 9 * * *","cronHumanReadable":"Every day at 9:00 AM UTC","status":"active","nextFireAt":"2026-06-02T09:00:00Z"}]}`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"triggers"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.URL != "https://api.example.com/api/projects/project_1/triggers" {
		t.Fatalf("path = %s", captured.URL)
	}
	if !strings.Contains(stdout.String(), "Daily check") || !strings.Contains(stdout.String(), "Every day at 9:00 AM UTC") {
		t.Fatalf("stdout = %s", stdout.String())
	}
}

func TestProfilesShowsTable(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "project_1", "My Project")
	doer, captured := captureJSONRequest(t, `{"items":[{"id":"prof_1","name":"fast-agent","agentType":"claude-code","vmSizeOverride":"cx22","taskMode":"task"}]}`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"profiles"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.URL != "https://api.example.com/api/projects/project_1/agent-profiles" {
		t.Fatalf("path = %s", captured.URL)
	}
	if !strings.Contains(stdout.String(), "fast-agent") {
		t.Fatalf("stdout = %s", stdout.String())
	}
}

func TestActivityShowsTable(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "project_1", "My Project")
	doer, captured := captureJSONRequest(t, `{"events":[{"id":"evt_1","eventType":"task.created","payload":{"title":"Started fix-bugs task"},"createdAt":1780099200000}]}`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"activity"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.URL != "https://api.example.com/api/projects/project_1/activity" {
		t.Fatalf("path = %s", captured.URL)
	}
	if !strings.Contains(stdout.String(), "Started fix-bugs task") {
		t.Fatalf("stdout = %s", stdout.String())
	}
}

func TestNodesShowsTable(t *testing.T) {
	doer, captured := captureJSONRequest(t, `[{"id":"node_1","name":"builder","cloudProvider":"hetzner","vmSize":"cx22","vmLocation":"fsn1","status":"running","ipAddress":"1.2.3.4"}]`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"nodes"}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.URL != "https://api.example.com/api/nodes" {
		t.Fatalf("path = %s", captured.URL)
	}
	output := stdout.String()
	if !strings.Contains(output, "hetzner") || !strings.Contains(output, "1.2.3.4") {
		t.Fatalf("stdout = %s", output)
	}
}

func TestMultilineValuesStayOnSingleTableRows(t *testing.T) {
	tests := []struct {
		name     string
		args     []string
		response string
		want     string
		env      map[string]string
	}{
		{
			name:     "notifications",
			args:     []string{"notifications"},
			response: `{"notifications":[{"id":"notif_1","type":"needs_input","title":"First line\nsecond line","createdAt":"2026-05-30T00:00:00Z"}],"unreadCount":1,"nextCursor":null}`,
			want:     "First line second line",
		},
		{
			name:     "activity",
			args:     []string{"activity"},
			response: `{"events":[{"id":"evt_1","eventType":"task.created","payload":{"title":"Started task\nwith wrapped title"},"createdAt":1780099200000}]}`,
			want:     "Started task with wrapped title",
			env:      activeProjectEnv(t),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			doer, _ := captureJSONRequest(t, tt.response, http.StatusOK)
			runtime, stdout, stderr := testRuntime(t, tt.args, doer, tt.env)

			code := Run(context.Background(), runtime)
			if code != 0 {
				t.Fatalf("code = %d stderr=%s", code, stderr.String())
			}
			lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
			if len(lines) != 2 {
				t.Fatalf("expected header plus one row, got %d lines: %s", len(lines), stdout.String())
			}
			if !strings.Contains(lines[1], tt.want) {
				t.Fatalf("row = %s", lines[1])
			}
		})
	}
}

func TestFixedCommandsJSONOutputUsesCurrentContracts(t *testing.T) {
	tests := []struct {
		name     string
		args     []string
		response string
		env      map[string]string
		assert   func(t *testing.T, value map[string]any)
	}{
		{
			name:     "chat list",
			args:     []string{"chat", "--json"},
			response: `{"sessions":[{"id":"sess_1","topic":"Fix bugs","status":"active","messageCount":5,"lastMessageAt":1780099200000}]}`,
			env:      activeProjectEnv(t),
			assert: func(t *testing.T, value map[string]any) {
				assertArrayField(t, value, "sessions")
			},
		},
		{
			name:     "chat detail",
			args:     []string{"chat", "sess_1", "--json"},
			response: `{"session":{"id":"sess_1","topic":"Fix bugs","status":"active","messageCount":1},"messages":[{"id":"msg_1","role":"assistant","content":"Done","createdAt":1780099200000}],"hasMore":false,"state":null}`,
			env:      activeProjectEnv(t),
			assert: func(t *testing.T, value map[string]any) {
				assertArrayField(t, value, "messages")
			},
		},
		{
			name:     "library",
			args:     []string{"library", "--json"},
			response: `{"files":[{"id":"file_1","filename":"spec.md","directory":"/","sizeBytes":1024,"uploadSource":"user","createdAt":"2026-05-30T00:00:00Z"}],"cursor":null,"total":1}`,
			env:      activeProjectEnv(t),
			assert: func(t *testing.T, value map[string]any) {
				assertArrayField(t, value, "files")
			},
		},
		{
			name:     "context",
			args:     []string{"context", "--json"},
			response: `{"entities":[{"id":"ent_1","name":"UserPrefs","entityType":"context","observationCount":5,"updatedAt":1780099200000}]}`,
			env:      activeProjectEnv(t),
			assert: func(t *testing.T, value map[string]any) {
				assertArrayField(t, value, "entities")
			},
		},
		{
			name:     "notifications",
			args:     []string{"notifications", "--json"},
			response: `{"notifications":[{"id":"notif_1","type":"task_complete","title":"Task done","createdAt":"2026-05-30T00:00:00Z"}],"unreadCount":1,"nextCursor":null}`,
			assert: func(t *testing.T, value map[string]any) {
				assertArrayField(t, value, "notifications")
			},
		},
		{
			name:     "triggers",
			args:     []string{"triggers", "--json"},
			response: `{"triggers":[{"id":"trig_1","name":"Daily check","sourceType":"cron","cronExpression":"0 9 * * *","status":"active","nextFireAt":"2026-06-02T09:00:00Z"}]}`,
			env:      activeProjectEnv(t),
			assert: func(t *testing.T, value map[string]any) {
				assertArrayField(t, value, "triggers")
			},
		},
		{
			name:     "profiles",
			args:     []string{"profiles", "--json"},
			response: `{"items":[{"id":"prof_1","name":"fast-agent","agentType":"claude-code","vmSizeOverride":"cx22","taskMode":"task"}]}`,
			env:      activeProjectEnv(t),
			assert: func(t *testing.T, value map[string]any) {
				assertArrayField(t, value, "items")
			},
		},
		{
			name:     "activity",
			args:     []string{"activity", "--json"},
			response: `{"events":[{"id":"evt_1","eventType":"task.created","payload":{"title":"Started fix-bugs task"},"createdAt":1780099200000}]}`,
			env:      activeProjectEnv(t),
			assert: func(t *testing.T, value map[string]any) {
				assertArrayField(t, value, "events")
			},
		},
		{
			name:     "nodes",
			args:     []string{"nodes", "--json"},
			response: `[{"id":"node_1","cloudProvider":"hetzner","vmSize":"cx22","vmLocation":"fsn1","status":"running","ipAddress":"1.2.3.4"}]`,
			assert: func(t *testing.T, value map[string]any) {
				assertArrayField(t, value, "nodes")
			},
		},
		{
			name:     "ideas",
			args:     []string{"ideas", "--json"},
			response: `{"tasks":[{"id":"idea_1","title":"Add dark mode","priority":1,"createdAt":"2026-05-30T00:00:00Z"}]}`,
			env:      activeProjectEnv(t),
			assert: func(t *testing.T, value map[string]any) {
				assertArrayField(t, value, "tasks")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			doer, _ := captureJSONRequest(t, tt.response, http.StatusOK)
			runtime, stdout, stderr := testRuntime(t, tt.args, doer, tt.env)

			code := Run(context.Background(), runtime)
			if code != 0 {
				t.Fatalf("code = %d stderr=%s", code, stderr.String())
			}
			var value map[string]any
			if err := json.Unmarshal(stdout.Bytes(), &value); err != nil {
				t.Fatalf("stdout is not valid JSON: %v\n%s", err, stdout.String())
			}
			tt.assert(t, value)
		})
	}
}

func TestStatusJSONOutputUsesCurrentContracts(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "project_1", "My Project")
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/sessions") {
			return jsonResponse(`{"sessions":[{"id":"sess_1","topic":"Fix bugs","status":"active","messageCount":5,"lastMessageAt":1780099200000}]}`, http.StatusOK), nil
		}
		return jsonResponse(`{"id":"project_1","name":"My Project","repository":"github.com/org/repo","activeSessionCount":1,"activeWorkspaceCount":0}`, http.StatusOK), nil
	})
	runtime, stdout, stderr := testRuntime(t, []string{"status", "--json"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	var value map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &value); err != nil {
		t.Fatalf("stdout is not valid JSON: %v\n%s", err, stdout.String())
	}
	if _, ok := value["project"].(map[string]any); !ok {
		t.Fatalf("project missing from %#v", value)
	}
	sessionsObj, ok := value["sessions"].(map[string]any)
	if !ok {
		t.Fatalf("sessions is not an object in %#v", value)
	}
	assertArrayField(t, sessionsObj, "sessions")
}

func TestProjectScopedCommandWithoutProjectFails(t *testing.T) {
	env := tempConfigEnv(t)
	// Auth but no active project
	cfg := CLIConfig{APIURL: "https://api.example.com", SessionCookie: "cookie=value"}
	if _, err := SaveConfig(env, cfg); err != nil {
		t.Fatal(err)
	}
	runtime, _, stderr := testRuntime(t, []string{"ideas"}, nil, env.values)

	code := Run(context.Background(), runtime)
	if code != 1 {
		t.Fatalf("expected failure, got code %d", code)
	}
	if !strings.Contains(stderr.String(), "no project specified") {
		t.Fatalf("stderr = %s", stderr.String())
	}
}

func TestProjectFlagOverridesConfig(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "default_proj", "Default")
	doer, captured := captureJSONRequest(t, `{"sessions":[]}`, http.StatusOK)
	runtime, _, stderr := testRuntime(t, []string{"--project", "01ABCDEFGHIJKLMNOPQRSTUVWX", "chat"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.URL != "https://api.example.com/api/projects/01ABCDEFGHIJKLMNOPQRSTUVWX/sessions" {
		t.Fatalf("path = %s", captured.URL)
	}
}

func TestLegacyTaskCommandStillWorks(t *testing.T) {
	doer, captured := captureJSONRequest(t, `{"taskId":"task_1","sessionId":"sess_1","status":"queued"}`, http.StatusAccepted)
	runtime, _, stderr := testRuntime(t, []string{
		"--project=project_1",
		"task",
		"submit",
		"Fix the bug",
	}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.URL != "https://api.example.com/api/projects/project_1/tasks/submit" {
		t.Fatalf("path = %s", captured.URL)
	}
}

func TestLegacyTasksDispatchStillWorks(t *testing.T) {
	doer, captured := captureJSONRequest(t, `{"taskId":"task_1","sessionId":"sess_1","status":"queued"}`, http.StatusAccepted)
	runtime, _, stderr := testRuntime(t, []string{
		"--project=project_1",
		"tasks",
		"dispatch",
		"--prompt=do the thing",
	}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if captured.JSON["message"] != "do the thing" {
		t.Fatalf("payload = %#v", captured.JSON)
	}
}

func TestStatusFallsBackToProjectList(t *testing.T) {
	env := tempConfigEnv(t)
	// Auth but no active project — status should fall back to listing projects
	cfg := CLIConfig{APIURL: "https://api.example.com", SessionCookie: "cookie=value"}
	if _, err := SaveConfig(env, cfg); err != nil {
		t.Fatal(err)
	}
	doer, _ := captureJSONRequest(t, `{"projects":[{"id":"01ABC","name":"My App","repository":"github.com/org/app","activeSessionCount":1}]}`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"status"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "My App") {
		t.Fatalf("expected project list fallback, stdout = %s", stdout.String())
	}
}

func TestIdeasEmptyState(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "project_1", "My Project")
	doer, _ := captureJSONRequest(t, `{"tasks":[]}`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"ideas"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "No ideas found") {
		t.Fatalf("stdout = %s", stdout.String())
	}
}

func TestLibraryEmptyState(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "project_1", "My Project")
	doer, _ := captureJSONRequest(t, `{"files":[],"cursor":null,"total":0}`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"library"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "No library files found") {
		t.Fatalf("stdout = %s", stdout.String())
	}
}

func TestContextEmptyState(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "project_1", "My Project")
	doer, _ := captureJSONRequest(t, `{"entities":[]}`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"context"}, doer, env.values)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "No knowledge entities found") {
		t.Fatalf("stdout = %s", stdout.String())
	}
}

func TestNodesEmptyState(t *testing.T) {
	doer, _ := captureJSONRequest(t, `[]`, http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"nodes"}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "No nodes found") {
		t.Fatalf("stdout = %s", stdout.String())
	}
}

func TestPickerInvalidNumber(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "", "")
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(`{"projects":[{"id":"01ABC","name":"Only"}]}`, http.StatusOK), nil
	})
	runtime, _, stderr := testRuntime(t, []string{"project", "use"}, doer, env.values)
	runtime.Stdin = bytes.NewBufferString("99\n")

	code := Run(context.Background(), runtime)
	if code != 1 {
		t.Fatalf("expected failure, got code %d", code)
	}
	if !strings.Contains(stderr.String(), "invalid selection") {
		t.Fatalf("stderr = %s", stderr.String())
	}
}

func TestPickerNonNumericInput(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "", "")
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(`{"projects":[{"id":"01ABC","name":"Only"}]}`, http.StatusOK), nil
	})
	runtime, _, stderr := testRuntime(t, []string{"project", "use"}, doer, env.values)
	runtime.Stdin = bytes.NewBufferString("abc\n")

	code := Run(context.Background(), runtime)
	if code != 1 {
		t.Fatalf("expected failure, got code %d", code)
	}
	if !strings.Contains(stderr.String(), "invalid selection") {
		t.Fatalf("stderr = %s", stderr.String())
	}
}

func TestPickerEmptyInput(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "", "")
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(`{"projects":[{"id":"01ABC","name":"Only"}]}`, http.StatusOK), nil
	})
	runtime, _, stderr := testRuntime(t, []string{"project", "use"}, doer, env.values)
	runtime.Stdin = bytes.NewBufferString("\n")

	code := Run(context.Background(), runtime)
	if code != 1 {
		t.Fatalf("expected failure, got code %d", code)
	}
	if !strings.Contains(stderr.String(), "no selection made") {
		t.Fatalf("stderr = %s", stderr.String())
	}
}

func TestUnknownCommandShowsHint(t *testing.T) {
	runtime, _, stderr := testRuntime(t, []string{"foobar"}, nil, nil)
	code := Run(context.Background(), runtime)
	if code != 1 {
		t.Fatalf("expected failure, got code %d", code)
	}
	if !strings.Contains(stderr.String(), "unknown command: foobar") || !strings.Contains(stderr.String(), "--help") {
		t.Fatalf("stderr = %s", stderr.String())
	}
}

func activeProjectEnv(t *testing.T) map[string]string {
	t.Helper()
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "project_1", "My Project")
	return env.values
}

func assertArrayField(t *testing.T, value map[string]any, field string) {
	t.Helper()
	items, ok := value[field].([]any)
	if !ok {
		t.Fatalf("%s is not an array in %#v", field, value)
	}
	if len(items) == 0 {
		t.Fatalf("%s is empty in %#v", field, value)
	}
}
