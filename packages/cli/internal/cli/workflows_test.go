package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

const workflowProject = "01K00000000000000000000000"

func TestWorkflowUnknownFlagsNeverReachHTTP(t *testing.T) {
	for _, args := range [][]string{{"chat", "new", "work", "--dry-run"}, {"profiles", "create", "--permission-mode", "auto"}, {"settings", "update", "--credential", "secret"}, {"tasks", "list", "--typo", "x"}} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			r, out, err := testRuntime(t, args, noRequestDoer(t), nil)
			if Run(context.Background(), r) == 0 || out.String() != "" || !strings.Contains(err.String(), "unknown flag") {
				t.Fatalf("unexpected output %q / %q", out.String(), err.String())
			}
		})
	}
}
func TestWorkflowFullJSONAndPageControls(t *testing.T) {
	h, req := captureJSONRequest(t, `{"sessions":[{"id":"s","attention":{"kind":"question"},"custom":null}],"total":9}`, 200)
	r, out, err := testRuntime(t, []string{"chat", "list", "--project", workflowProject, "--limit", "2", "--offset", "4", "--json"}, h, nil)
	if Run(context.Background(), r) != 0 {
		t.Fatal(err.String())
	}
	if !strings.Contains(req.URL, "limit=2") || !strings.Contains(req.URL, "offset=4") || !strings.Contains(out.String(), `"custom": null`) {
		t.Fatalf("%s %s", req.URL, out.String())
	}
}
func TestTranscriptExactTiedCursorSnapshot(t *testing.T) {
	calls := 0
	h := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		if req.URL.Query().Get("compact") != "false" {
			t.Fatal("compact transcript")
		}
		if calls == 1 {
			return jsonResponse(`{"messages":[{"id":"b","createdAt":10,"sequence":2,"role":"tool","toolMetadata":{"x":1}},{"id":"c","createdAt":10,"sequence":3}],"hasMore":true}`, 200), nil
		}
		if req.URL.Query().Get("before") != `[10,2,"b"]` {
			t.Fatalf("cursor %q", req.URL.Query().Get("before"))
		}
		return jsonResponse(`{"messages":[{"id":"a","createdAt":10,"sequence":1,"content":"private fixture"}],"hasMore":false}`, 200), nil
	})
	r, out, err := testRuntime(t, []string{"chat", "export", "s", "--project", workflowProject, "--json"}, h, nil)
	if Run(context.Background(), r) != 0 {
		t.Fatal(err.String())
	}
	var v map[string]any
	if e := json.Unmarshal(out.Bytes(), &v); e != nil {
		t.Fatal(e)
	}
	rows := v["messages"].([]any)
	if len(rows) != 3 || rows[0].(map[string]any)["id"] != "a" || v["complete"] != true {
		t.Fatal(out.String())
	}
}
func TestTranscriptFailureProducesNoPartialArtifact(t *testing.T) {
	h := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(`{"messages":[],"hasMore":true}`, 200), nil
	})
	r, out, err := testRuntime(t, []string{"chat", "export", "s", "--project", workflowProject}, h, nil)
	if Run(context.Background(), r) == 0 || out.Len() != 0 || !strings.Contains(err.String(), "incomplete") {
		t.Fatalf("%q %q", out.String(), err.String())
	}
}
func TestWorkflowNamedResourceAmbiguity(t *testing.T) {
	h, _ := captureJSONRequest(t, `{"items":[{"id":"one","name":"Sol"},{"id":"two","name":"sol"}]}`, 200)
	r, _, err := testRuntime(t, []string{"profiles", "get", "Sol", "--project", workflowProject}, h, nil)
	if Run(context.Background(), r) == 0 || !strings.Contains(err.String(), "ambiguous") {
		t.Fatal(err.String())
	}
}
func TestWorkflowReadMethodsAndPaths(t *testing.T) {
	for _, c := range workflowContracts() {
		t.Run(c.command, func(t *testing.T) {
			if requiresNamedWorkflowFixture(c.command) {
				return
			}
			args := append(strings.Fields(c.command), "--project", workflowProject, "--json")
			for i := 0; i < c.args; i++ {
				args = append(args, fmt.Sprintf("id%d", i))
			}
			h, req := captureJSONRequest(t, `{}`, 200)
			r, _, err := testRuntime(t, args, h, nil)
			if Run(context.Background(), r) != 0 {
				t.Fatal(err.String())
			}
			if req.Method != c.method || !requestUsesWorkflowProject(c.command, req.URL) {
				t.Fatalf("unsafe read %s %s", req.Method, req.URL)
			}
		})
	}
}
func TestSettingsAllowlistedAndPreviewNeverMutates(t *testing.T) {
	h, _ := captureJSONRequest(t, `{"id":"p","name":"SAM","runtime":{"value":"secret-canary"},"credentials":"secret-canary"}`, 200)
	r, out, err := testRuntime(t, []string{"settings", "--project", workflowProject, "--json"}, h, nil)
	if Run(context.Background(), r) != 0 {
		t.Fatal(err.String())
	}
	if strings.Contains(out.String(), "secret-canary") {
		t.Fatal("settings leak")
	}
	r, out, err = testRuntime(t, []string{"settings", "update", "--project", workflowProject, "--name", "SAM", "--preview", "--json"}, noRequestDoer(t), nil)
	if Run(context.Background(), r) != 0 {
		t.Fatal(err.String())
	}
	if !strings.Contains(out.String(), `"preview": true`) {
		t.Fatal(out.String())
	}
}

func requiresNamedWorkflowFixture(command string) bool {
	return strings.HasPrefix(command, "profiles get") || strings.HasPrefix(command, "skills get") || command == "profiles resolve" || command == "skills resolve"
}

func requestUsesWorkflowProject(command, requestURL string) bool {
	if command == "notifications list" {
		return strings.Contains(requestURL, "projectId="+workflowProject)
	}
	return strings.Contains(requestURL, "/api/projects/"+workflowProject)
}
