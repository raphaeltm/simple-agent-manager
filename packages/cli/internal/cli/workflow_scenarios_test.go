package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoreWorkLoopWithExplicitProfileSkillAndFollowup(t *testing.T) {
	calls := []string{}
	h := coreWorkLoopHandler(t, &calls)
	for _, args := range [][]string{{"tasks", "submit", "--prompt-stdin", "--agent-profile", "Sol", "--skill", "Audit", "--idempotency-key", "work-1"}, {"chat", "send", "session", "--content-stdin", "--idempotency-key", "followup-1"}, {"tasks", "wait", "task", "--timeout", "1s", "--interval", "1ms"}} {
		r, out, err := testRuntime(t, append(args, "--project", workflowProject, "--json"), h, nil)
		if args[0] == "chat" {
			r.Stdin = strings.NewReader("continue")
		} else {
			r.Stdin = strings.NewReader("draft PR; do not merge")
		}
		if Run(context.Background(), r) != 0 {
			t.Fatal(err.String())
		}
		if out.Len() == 0 {
			t.Fatal("missing receipt")
		}
	}
	if len(calls) != 5 {
		t.Fatalf("calls %v", calls)
	}
}
func TestPagedInspectionAllPagesAndFailures(t *testing.T) {
	for _, family := range []string{"tasks", "library", "chat", "context", "notifications", "projects"} {
		t.Run(family, func(t *testing.T) {
			checkPagedInspection(t, family)
		})
	}
	h, _ := captureJSONRequest(t, `{"tasks":[],"nextCursor":"repeat"}`, 200)
	r, out, err := testRuntime(t, []string{"tasks", "list", "--project", workflowProject, "--all-pages"}, h, nil)
	if Run(context.Background(), r) == 0 || out.Len() != 0 || !strings.Contains(err.String(), "no progress") {
		t.Fatalf("%s %s", out.String(), err.String())
	}
}
func TestTaskWaitFailedAndTimedOut(t *testing.T) {
	for _, status := range []string{"failed", "cancelled", "running"} {
		t.Run(status, func(t *testing.T) {
			h, _ := captureJSONRequest(t, `{"status":"`+status+`"}`, 200)
			r, out, err := testRuntime(t, []string{"tasks", "wait", "task", "--project", workflowProject, "--timeout", "1ms", "--interval", "2ms", "--json"}, h, nil)
			code := Run(context.Background(), r)
			want := 4
			if status == "running" {
				want = 3
			}
			if code != want || out.Len() == 0 || err.Len() != 0 {
				t.Fatalf("code %d out %s err %s", code, out.String(), err.String())
			}
		})
	}
}
func TestSafeMetadataCreateUpdateCloneAndPreview(t *testing.T) {
	for _, family := range []string{"profiles", "skills", "settings", "tasks", "ideas"} {
		for _, action := range []string{"create", "update"} {
			if family == "settings" && action == "create" {
				continue
			}
			t.Run(family+" "+action, func(t *testing.T) {
				checkMetadataMutation(t, family, action)
			})
		}
	}
}
func TestSessionLifecycleAndLineageAreDistinct(t *testing.T) {
	for _, action := range []string{"cancel", "sleep", "fork", "retry"} {
		t.Run(action, func(t *testing.T) {
			checkSessionLifecycle(t, action)
		})
	}
}
func TestLibraryAndRemoteFileDownloadsRequireNewPrivateArtifacts(t *testing.T) {
	for _, family := range []string{"library", "files"} {
		t.Run(family, func(t *testing.T) {
			checkArtifactDownload(t, family)
		})
	}
}
func TestCommentsAreNotesWithoutSendingToAgent(t *testing.T) {
	for _, action := range []string{"add", "reply", "resolve", "reopen"} {
		t.Run(action, func(t *testing.T) {
			h, req := captureJSONRequest(t, `{"ok":true}`, 200)
			args := []string{"comments", action, "session", "message", "--project", workflowProject, "--idempotency-key", "note"}
			if action == "add" || action == "reply" {
				args = append(args, "--body", "synthetic note")
			}
			r, _, err := testRuntime(t, args, h, nil)
			if Run(context.Background(), r) != 0 {
				t.Fatal(err.String())
			}
			if req.JSON["clientMutationId"] != "note" || strings.Contains(req.URL, "/prompt") || strings.Contains(req.URL, "/send") {
				t.Fatal(req.URL)
			}
		})
	}
}

func TestAttachmentUploadUsesPresignedOriginWithoutSAMCredentials(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fixture.txt")
	if e := os.WriteFile(path, []byte("private synthetic"), 0600); e != nil {
		t.Fatal(e)
	}
	h := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Host == "account.r2.cloudflarestorage.com" {
			if req.Method != "PUT" || req.Header.Get("Cookie") != "" || req.Header.Get("Authorization") != "" {
				t.Fatal("credential leaked to upload origin")
			}
			b, _ := io.ReadAll(req.Body)
			if string(b) != "private synthetic" {
				t.Fatal("bad upload bytes")
			}
			return jsonResponse(`{}`, 200), nil
		}
		if strings.HasSuffix(req.URL.Path, "request-upload") {
			return jsonResponse(`{"uploadId":"upload","uploadUrl":"https://account.r2.cloudflarestorage.com/bucket/object?signature=synthetic"}`, 200), nil
		}
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		refs := body["attachments"].([]any)
		if refs[0].(map[string]any)["uploadId"] != "upload" {
			t.Fatal("missing uploaded reference")
		}
		return jsonResponse(`{"taskId":"task","status":"queued"}`, 202), nil
	})
	r, _, err := testRuntime(t, []string{"tasks", "submit", "work", "--project", workflowProject, "--attachment", path}, h, nil)
	if Run(context.Background(), r) != 0 {
		t.Fatal(err.String())
	}
}
func TestLibraryUploadMultipartPayload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "artifact.txt")
	_ = os.WriteFile(path, []byte("synthetic"), 0600)
	h := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path != "/api/projects/"+workflowProject+"/library/upload" || req.Method != "POST" {
			t.Fatal(req.URL.Path)
		}
		if e := req.ParseMultipartForm(1 << 20); e != nil {
			t.Fatal(e)
		}
		file, _, e := req.FormFile("file")
		if e != nil {
			t.Fatal(e)
		}
		defer file.Close()
		body, _ := io.ReadAll(file)
		if string(body) != "synthetic" || req.FormValue("directory") != "/docs/" {
			t.Fatal("bad upload form")
		}
		return jsonResponse(`{"id":"artifact"}`, 201), nil
	})
	r, out, err := testRuntime(t, []string{"library", "upload", path, "--directory", "/docs/", "--project", workflowProject, "--json"}, h, nil)
	if Run(context.Background(), r) != 0 {
		t.Fatal(err.String())
	}
	if !strings.Contains(out.String(), `"id": "artifact"`) {
		t.Fatal(out.String())
	}
}
func TestCloneMetadataNeverCopiesAuthorityOrMutatesSharedSource(t *testing.T) {
	for _, family := range []string{"profiles", "skills"} {
		t.Run(family, func(t *testing.T) {
			checkMetadataClone(t, family)
		})
	}
}
func TestLinkedIdeaExecutePreservesPromptAndReturnsAcceptedReceiptOnLinkFailure(t *testing.T) {
	for _, linkStatus := range []int{200, 403} {
		t.Run(fmt.Sprint(linkStatus), func(t *testing.T) {
			checkIdeaExecute(t, linkStatus)
		})
	}
}
func TestAttentionAnswersRejectPermissionKindsAndUnlistedOptions(t *testing.T) {
	for _, kind := range []string{"permission", "needs_input"} {
		t.Run(kind, func(t *testing.T) {
			writes := 0
			h := roundTripFunc(func(req *http.Request) (*http.Response, error) {
				if req.Method == "POST" {
					writes++
					return jsonResponse(`{"resolved":true}`, 200), nil
				}
				return jsonResponse(`{"session":{"attention":{"markerId":"marker","kind":"`+kind+`","options":["Continue"]}}}`, 200), nil
			})
			r, _, err := testRuntime(t, []string{"chat", "answer", "session", "marker", "--answer", "Continue", "--project", workflowProject}, h, nil)
			code := Run(context.Background(), r)
			if kind == "permission" {
				if code == 0 || writes != 0 {
					t.Fatal("answered permission")
				}
			} else if code != 0 || writes != 1 {
				t.Fatal(err.String())
			}
		})
	}
}
func TestProjectResolutionChecksEveryPageForAmbiguity(t *testing.T) {
	calls := 0
	h := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return jsonResponse(`{"projects":[{"id":"one","name":"SAM"}],"nextCursor":"later"}`, 200), nil
		}
		if req.URL.Query().Get("cursor") != "later" {
			t.Fatal("missing cursor")
		}
		return jsonResponse(`{"projects":[{"id":"two","name":"sam"}],"nextCursor":null}`, 200), nil
	})
	r, _, err := testRuntime(t, []string{"tasks", "list", "--project", "SAM"}, h, nil)
	if Run(context.Background(), r) == 0 || calls != 2 || !strings.Contains(err.String(), "multiple projects") {
		t.Fatalf("%d %s", calls, err.String())
	}
}
func TestWorkflowStructuredErrorsDoNotLeakServerHTML(t *testing.T) {
	for _, status := range []int{401, 403, 404, 409, 429, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			h, _ := captureJSONRequest(t, "private-secret-canary", status)
			r, out, err := testRuntime(t, []string{"tasks", "list", "--project", workflowProject, "--json"}, h, nil)
			if Run(context.Background(), r) == 0 || out.Len() != 0 || strings.Contains(err.String(), "private-secret-canary") {
				t.Fatalf("%s %s", out.String(), err.String())
			}
			var value map[string]any
			if e := json.Unmarshal(err.Bytes(), &value); e != nil {
				t.Fatal(e)
			}
			if value["status"] != float64(status) || value["error"] != "HTTP_ERROR" {
				t.Fatal(err.String())
			}
		})
	}
}

func TestWorkflowInvalidInputFailsBeforeRequests(t *testing.T) {
	cases := [][]string{{"tasks", "wait"}, {"tasks", "wait", "task", "--interval", "bad"}, {"tasks", "wait", "task", "--timeout", "0s"}, {"tasks", "create", "extra", "--title", "draft"}, {"settings", "update", "extra", "--name", "Name"}, {"projects", "extra"}, {"status", "extra"}, {"auth", "status", "extra"}, {"chat", "send"}, {"chat", "export"}, {"chat", "cancel", "session", "extra"}, {"chat", "sleep", "session", "extra"}, {"chat", "fork", "session", "extra"}, {"profiles", "create", "extra", "--name", "Name"}, {"tasks", "list", "--limit", "0"}, {"chat", "list", "--offset", "-1"}, {"chat", "send", "session", "--content", "one", "two"}, {"tasks", "submit", "one", "--prompt-stdin"}, {"chat", "new", "one", "--prompt-file", "unused"}, {"files", "download", "--ref", "main", "--path", "private"}, {"library", "upload"}, {"comments", "add", "session"}, {"comments", "reply", "session", "thread"}, {"chat", "answer", "session", "marker"}, {"chat", "new", "prompt", "--agent", "codex", "--agent", "codex"}, {"tasks", "submit", "--prompt-file", "/does-not-exist"}, {"tasks", "submit", "--prompt-stdin"}, {"chat", "send", "session", "--content-stdin"}}
	for _, args := range cases {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			r, out, err := testRuntime(t, append(args, "--project", workflowProject), noRequestDoer(t), nil)
			r.Stdin = strings.NewReader("")
			if Run(context.Background(), r) == 0 || out.Len() != 0 || err.Len() == 0 {
				t.Fatalf("out %s err %s", out.String(), err.String())
			}
		})
	}
}
func TestTranscriptNDJSONHydrationBoundsAndCursorFailures(t *testing.T) {
	for _, scenario := range []string{"ndjson", "hydrate", "bytes", "missing-id", "missing-sequence", "duplicate", "write-failure", "existing-output", "bad-budget"} {
		t.Run(scenario, func(t *testing.T) {
			checkTranscriptScenario(t, scenario)
		})
	}
}
func TestExplicitUnknownProfileAndInvalidStatusProjectNeverFallBack(t *testing.T) {
	for _, args := range [][]string{{"tasks", "submit", "work", "--agent-profile", "unknown", "--project", workflowProject}, {"status", "--project", "unknown"}} {
		writes := 0
		h := roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if req.Method != "GET" {
				writes++
			}
			return jsonResponse(`{"items":[],"projects":[]}`, 200), nil
		})
		r, out, err := testRuntime(t, args, h, nil)
		if Run(context.Background(), r) == 0 || writes != 0 || out.Len() != 0 {
			t.Fatalf("unsafe fallback %s %s", out.String(), err.String())
		}
	}
}
func TestSettingsMasksPlainRuntimeValuesAndContents(t *testing.T) {
	h := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "runtime-config") {
			return jsonResponse(`{"envVars":[{"key":"PLAIN","value":"secret-canary","isSecret":false}],"files":[{"path":"private","content":"secret-canary","isSecret":false}]}`, 200), nil
		}
		return jsonResponse(`{"name":"SAM","agentDefaults":{"openai-codex":{"model":"configured","permissionMode":"default"}}}`, 200), nil
	})
	r, out, err := testRuntime(t, []string{"settings", "--project", workflowProject, "--json"}, h, nil)
	if Run(context.Background(), r) != 0 {
		t.Fatal(err.String())
	}
	if strings.Contains(out.String(), "secret-canary") || !strings.Contains(out.String(), "REDACTED") || !strings.Contains(out.String(), "resolutionOrder") {
		t.Fatal(out.String())
	}
}
func TestPromptInputFileAndReferenceFilePreserveIntent(t *testing.T) {
	prompt := filepath.Join(t.TempDir(), "request")
	_ = os.WriteFile(prompt, []byte("  draft PR; do not merge\n"), 0600)
	refs := filepath.Join(t.TempDir(), "refs")
	_ = os.WriteFile(refs, []byte(`[{"uploadId":"existing","filename":"safe.txt","size":1,"contentType":"text/plain"}]`), 0600)
	h, req := captureJSONRequest(t, `{"taskId":"task","status":"queued"}`, 202)
	r, _, err := testRuntime(t, []string{"tasks", "submit", "--prompt-file", prompt, "--attachment-ref-file", refs, "--project", workflowProject}, h, nil)
	if Run(context.Background(), r) != 0 {
		t.Fatal(err.String())
	}
	if req.JSON["message"] != "  draft PR; do not merge\n" || len(req.JSON["attachments"].([]any)) != 1 {
		t.Fatal("intent changed")
	}
}

func TestStructuredServerErrorsNeverEchoPrivateResponseText(t *testing.T) {
	h, _ := captureJSONRequest(t, `{"error":"BAD_REQUEST","message":"private-secret-canary"}`, 400)
	r, _, err := testRuntime(t, []string{"tasks", "list", "--project", workflowProject, "--json"}, h, nil)
	if Run(context.Background(), r) == 0 || strings.Contains(err.String(), "private-secret-canary") {
		t.Fatal("private server message exposed")
	}
	if !strings.Contains(err.String(), "BAD_REQUEST") {
		t.Fatal("stable error code missing")
	}
}

func checkPagedInspection(t *testing.T, family string) {
	key, next := "tasks", "nextCursor"
	switch family {
	case "library":
		key = "files"
		next = "cursor"
	case "chat":
		key = "sessions"
		next = "total"
	case "context":
		key = "entities"
		next = "total"
	case "notifications":
		key = "notifications"
	case "projects":
		key = "projects"
	}
	calls := 0
	h := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		continuation := any("next")
		if calls == 2 {
			continuation = nil
		}
		if next == "total" {
			continuation = 2
			if calls == 2 && req.URL.Query().Get("offset") != "1" {
				t.Fatal("offset not advanced")
			}
		}
		body, _ := json.Marshal(map[string]any{key: []any{map[string]any{"id": fmt.Sprint(calls)}}, next: continuation})
		return jsonResponse(string(body), 200), nil
	})
	r, out, err := testRuntime(t, []string{family, "--project", workflowProject, "--all-pages", "--json"}, h, nil)
	if Run(context.Background(), r) != 0 {
		t.Fatal(err.String())
	}
	if calls != 2 || !strings.Contains(out.String(), `"complete": true`) {
		t.Fatalf("%d %s", calls, out.String())
	}
}

func checkMetadataMutation(t *testing.T, family, action string) {
	h := metadataMutationHandler(t, family, action)
	args := []string{family, action}
	if action == "update" && family != "settings" {
		args = append(args, "item")
	}
	if family == "tasks" || family == "ideas" {
		args = append(args, "--title", "Draft", "--priority", "1")
	} else {
		args = append(args, "--name", "New")
	}
	r, out, err := testRuntime(t, append(args, "--project", workflowProject, "--json"), h, nil)
	if Run(context.Background(), r) != 0 {
		t.Fatal(err.String())
	}
	if out.Len() == 0 {
		t.Fatal("missing output")
	}
}

func checkSessionLifecycle(t *testing.T, action string) {
	writes := 0
	h := sessionLifecycleHandler(t, action, &writes)
	r, out, err := testRuntime(t, []string{"chat", action, "session", "--project", workflowProject, "--json"}, h, nil)
	if Run(context.Background(), r) != 0 {
		t.Fatal(err.String())
	}
	want := 1
	if action == "fork" || action == "retry" {
		want = 0
		if !strings.Contains(out.String(), `"launch": false`) {
			t.Fatal(out.String())
		}
	}
	if writes != want {
		t.Fatalf("unintended writes %d", writes)
	}
}

func checkArtifactDownload(t *testing.T, family string) {
	output := filepath.Join(t.TempDir(), "artifact")
	h := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("synthetic artifact"))}, nil
	})
	args := []string{family, "download"}
	if family == "library" {
		args = append(args, "file")
	} else {
		args = append(args, "--ref", "main", "--path", "docs/file")
	}
	args = append(args, "--project", workflowProject, "--output", output, "--json")
	r, out, err := testRuntime(t, args, h, nil)
	if Run(context.Background(), r) != 0 {
		t.Fatal(err.String())
	}
	b, _ := os.ReadFile(output)
	if string(b) != "synthetic artifact" || !strings.Contains(out.String(), `"complete": true`) {
		t.Fatal(out.String())
	}
	info, _ := os.Stat(output)
	if info.Mode().Perm() != 0600 {
		t.Fatal(info.Mode())
	}
	r, _, err = testRuntime(t, args, h, nil)
	if Run(context.Background(), r) == 0 {
		t.Fatal("overwrote existing artifact")
	}
}

func checkMetadataClone(t *testing.T, family string) {
	writes := 0
	h := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.Method == "GET" {
			if strings.HasSuffix(req.URL.Path, "/source") {
				return jsonResponse(`{"id":"source","projectId":null,"description":"shared","permissionMode":"auto","githubCliPolicy":{"mode":"custom"},"model":"expensive"}`, 200), nil
			}
			return jsonResponse(`{"items":[{"id":"source","name":"Sol"}]}`, 200), nil
		}
		writes++
		if !strings.HasSuffix(req.URL.Path, "/cli/"+family) || req.Method != "POST" {
			t.Fatal("mutated shared source")
		}
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		if len(body) != 2 || body["name"] != "New" || body["description"] != "shared" {
			t.Fatalf("unsafe clone %v", body)
		}
		return jsonResponse(`{"id":"new"}`, 201), nil
	})
	r, out, err := testRuntime(t, []string{family, "clone", "Sol", "--name", "New", "--project", workflowProject, "--json"}, h, nil)
	if Run(context.Background(), r) != 0 {
		t.Fatal(err.String())
	}
	if writes != 1 || !strings.Contains(out.String(), `"configurationCopied": false`) {
		t.Fatal(out.String())
	}
}

func checkIdeaExecute(t *testing.T, linkStatus int) {
	submits := 0
	h := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.Method == "GET" {
			return jsonResponse(`{"id":"idea","title":"Draft","description":"do not merge"}`, 200), nil
		}
		if strings.HasSuffix(req.URL.Path, "/submit") {
			submits++
			var body map[string]any
			_ = json.NewDecoder(req.Body).Decode(&body)
			if body["message"] != "Draft\n\ndo not merge" || body["taskMode"] != "conversation" {
				t.Fatal(body)
			}
			return jsonResponse(`{"taskId":"new","sessionId":"session","status":"queued"}`, 202), nil
		}
		if req.URL.Path != "/api/projects/"+workflowProject+"/sessions/session/ideas" {
			t.Fatal(req.URL.Path)
		}
		return jsonResponse(`{"linked":true}`, linkStatus), nil
	})
	r, out, err := testRuntime(t, []string{"ideas", "execute", "idea", "--launch", "--project", workflowProject, "--json"}, h, nil)
	code := Run(context.Background(), r)
	if (code == 0) != (linkStatus == 200) || submits != 1 || !strings.Contains(out.String(), `"taskId": "new"`) {
		t.Fatalf("%d %s %s", code, out.String(), err.String())
	}
}

func checkTranscriptScenario(t *testing.T, scenario string) {
	row := map[string]any{"id": "message", "createdAt": 1, "sequence": 1, "role": "tool", "content": "synthetic"}
	if scenario == "missing-id" {
		delete(row, "id")
	}
	if scenario == "missing-sequence" {
		delete(row, "sequence")
	}
	rows := []any{row}
	if scenario == "duplicate" {
		rows = append(rows, row)
	}
	body, _ := json.Marshal(map[string]any{"messages": rows, "hasMore": false})
	h := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "tool-content") {
			return jsonResponse(`{"source":"archived_unavailable","content":null}`, 200), nil
		}
		return jsonResponse(string(body), 200), nil
	})
	args := []string{"chat", "export", "session", "--project", workflowProject}
	env := map[string]string{"SAM_API_URL": "https://api.example.com", "SAM_SESSION_COOKIE": "fixture=value"}
	switch scenario {
	case "ndjson":
		args = append(args, "--ndjson")
	case "hydrate":
		args = append(args, "--hydrate-tools")
	case "bytes":
		env["SAM_CLI_MAX_EXPORT_BYTES"] = "1"
	case "bad-budget":
		env["SAM_CLI_MAX_EXPORT_BYTES"] = "bad"
		h = noRequestDoer(t).(roundTripFunc)
	case "write-failure":
		args = append(args, "--output", filepath.Join(t.TempDir(), "missing", "export"))
	case "existing-output":
		path := filepath.Join(t.TempDir(), "export")
		_ = os.WriteFile(path, []byte("unchanged"), 0600)
		args = append(args, "--output", path)
	}
	r, out, err := testRuntime(t, args, h, env)
	code := Run(context.Background(), r)
	success := scenario == "ndjson" || scenario == "hydrate"
	if (code == 0) != success {
		t.Fatalf("%d %s %s", code, out.String(), err.String())
	}
	if !success && out.Len() != 0 {
		t.Fatal("partial output leaked")
	}
	if scenario == "hydrate" && !strings.Contains(out.String(), "archived_unavailable") {
		t.Fatal(out.String())
	}
}

func coreWorkLoopHandler(t *testing.T, calls *[]string) roundTripFunc {
	return func(req *http.Request) (*http.Response, error) {
		*calls = append(*calls, req.Method+" "+req.URL.Path)
		switch req.URL.Path {
		case "/api/projects/" + workflowProject + "/agent-profiles":
			return jsonResponse(`{"items":[{"id":"sol","name":"Sol","model":"gpt-6.1-sol"}]}`, 200), nil
		case "/api/projects/" + workflowProject + "/skills":
			return jsonResponse(`{"items":[{"id":"audit","name":"Audit"}]}`, 200), nil
		case "/api/projects/" + workflowProject + "/tasks/submit":
			var body map[string]any
			_ = json.NewDecoder(req.Body).Decode(&body)
			if body["agentProfileId"] != "sol" || body["skillId"] != "audit" || body["message"] != "draft PR; do not merge" || req.Header.Get("Idempotency-Key") != "work-1" {
				t.Fatalf("incorrect dispatch %v", body)
			}
			return jsonResponse(`{"taskId":"task","sessionId":"session","status":"queued"}`, 202), nil
		case "/api/projects/" + workflowProject + "/sessions/session/prompt":
			var body map[string]any
			_ = json.NewDecoder(req.Body).Decode(&body)
			if body["content"] != "continue" || req.Header.Get("Idempotency-Key") != "followup-1" {
				t.Fatalf("incorrect followup %v", body)
			}
			return jsonResponse(`{"accepted":true,"deliveryId":"d"}`, 202), nil
		case "/api/projects/" + workflowProject + "/tasks/task":
			return jsonResponse(`{"id":"task","status":"completed","outputPrUrl":"https://example.com/draft"}`, 200), nil
		default:
			t.Fatalf("unexpected path %s", req.URL.Path)
			return nil, nil
		}
	}
}

func metadataMutationHandler(t *testing.T, family, action string) roundTripFunc {
	return func(req *http.Request) (*http.Response, error) {
		if req.Method == "GET" {
			if strings.HasSuffix(req.URL.Path, "/agent-profiles") || strings.HasSuffix(req.URL.Path, "/skills") {
				return jsonResponse(`{"items":[{"id":"item","name":"Sol"}]}`, 200), nil
			}
			return jsonResponse(`{"id":"item","projectId":"`+workflowProject+`","updatedAt":"2026-10-09T01:00:00Z"}`, 200), nil
		}
		var body map[string]any
		if e := json.NewDecoder(req.Body).Decode(&body); e != nil {
			t.Fatal(e)
		}
		assertSafeMetadataBody(t, family, action, body)
		return jsonResponse(`{"updated":true,"id":"item"}`, 200), nil
	}
}

func sessionLifecycleHandler(t *testing.T, action string, writes *int) roundTripFunc {
	return func(req *http.Request) (*http.Response, error) {
		if req.Method == "POST" {
			(*writes)++
			if action == "sleep" && req.URL.Path != "/api/workspaces/workspace/sleep" {
				t.Fatal(req.URL.Path)
			}
			return jsonResponse(`{"ok":true}`, 200), nil
		}
		if strings.HasSuffix(req.URL.Path, "/messages") {
			if req.URL.Query().Get("order") != "asc" || req.URL.Query().Get("roles") != "user" {
				t.Fatal("wrong original prompt query")
			}
			return jsonResponse(`{"messages":[{"content":"original"}]}`, 200), nil
		}
		return jsonResponse(`{"session":{"id":"session","workspaceId":"workspace","task":{"id":"task"}}}`, 200), nil
	}
}

func assertSafeMetadataBody(t *testing.T, family, action string, body map[string]any) {
	if family == "settings" || family == "profiles" || family == "skills" {
		if action == "update" && body["expectedUpdatedAt"] == nil {
			t.Fatal("missing conditional version")
		}
		if body["permissionMode"] != nil {
			t.Fatal("unsafe field")
		}
	}
}
