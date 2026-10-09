package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// All content is synthetic; no production sessions or credentials are fixtures.
func attentionScenarios() []struct{ name, field string } {
	return []struct{ name, field string }{
		{"populated", `,"attention":{"markerId":"marker_1","kind":"permission","createdAt":1791500000123,"expiresAt":1791500060123,"reason":"Choose an option","options":["allow","deny"]}`},
		{"nullable summary fields", `,"attention":{"markerId":"marker_2","kind":"input","createdAt":1791500000123,"expiresAt":null,"reason":null,"options":[]}`},
		{"null", `,"attention":null`},
		{"omitted", ""},
	}
}

func sessionPayload(field string) string {
	return `{"id":"session_1","topic":"Synthetic example","status":"active","messageCount":2,"startedAt":1791500000000,"lastMessageAt":1791500000123` + field + `}`
}

func detailPayload(session string) string {
	return `{"session":` + session + `,"messages":[{"id":"msg_1","role":"user","content":"Synthetic question\nwith a second line","createdAt":1791500000123},{"id":"msg_2","role":"assistant","content":"Synthetic answer with <code> & Unicode: café","createdAt":"2026-10-09T03:27:09Z"}],"hasMore":true}`
}

func assertSessionJSON(t *testing.T, got any, expected string) {
	t.Helper()
	var want map[string]any
	if err := json.Unmarshal([]byte(expected), &want); err != nil {
		t.Fatal(err)
	}
	// Session has always omitted absent/null attention when writing JSON.
	if want["attention"] == nil {
		delete(want, "attention")
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("session JSON = %#v, want %#v", got, want)
	}
}

func TestSessionAttentionClientDecoding(t *testing.T) {
	for _, scenario := range attentionScenarios() {
		t.Run(scenario.name, func(t *testing.T) {
			session := sessionPayload(scenario.field)
			t.Run("list", func(t *testing.T) { checkAttentionListClient(t, session) })
			t.Run("detail", func(t *testing.T) { checkAttentionDetailClient(t, session) })
		})
	}
}

func checkAttentionListClient(t *testing.T, session string) {
	t.Helper()
	doer, captured := captureJSONRequest(t, `{"sessions":[`+session+`]}`, http.StatusOK)
	client := NewAPIClient(CLIConfig{APIURL: "https://api.example.com"}, doer)
	response, err := client.ListSessions(context.Background(), "project_1")
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Sessions) != 1 {
		t.Fatal("expected one session")
	}
	assertAttentionRequest(t, captured, "/api/projects/project_1/sessions")
	assertSessionRoundTrip(t, response.Sessions[0], session)
}

func checkAttentionDetailClient(t *testing.T, session string) {
	t.Helper()
	doer, captured := captureJSONRequest(t, detailPayload(session), http.StatusOK)
	client := NewAPIClient(CLIConfig{APIURL: "https://api.example.com"}, doer)
	response, err := client.GetSessionDetail(context.Background(), "project_1", "session_1")
	if err != nil {
		t.Fatal(err)
	}
	assertAttentionRequest(t, captured, "/api/projects/project_1/sessions/session_1")
	assertSessionRoundTrip(t, response.Session, session)
	data, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	assertAttentionMessages(t, decodeAttentionJSON(t, data), session)
}

func assertAttentionRequest(t *testing.T, got *capturedRequest, path string) {
	t.Helper()
	if got.Method != http.MethodGet || got.URL != "https://api.example.com"+path {
		t.Fatalf("unexpected request: %#v", got)
	}
}

func assertSessionRoundTrip(t *testing.T, session Session, payload string) {
	t.Helper()
	data, err := json.Marshal(session)
	if err != nil {
		t.Fatal(err)
	}
	assertSessionJSON(t, decodeAttentionJSON(t, data), payload)
}

func decodeAttentionJSON(t *testing.T, data []byte) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func assertAttentionMessages(t *testing.T, value map[string]any, session string) {
	t.Helper()
	expected := decodeAttentionJSON(t, []byte(detailPayload(session)))
	if !reflect.DeepEqual(value["messages"], expected["messages"]) || value["hasMore"] != true {
		t.Fatal("message roles, content, timestamps or hasMore changed")
	}
}

type attentionCommandScenario struct {
	name  string
	args  []string
	paths []string
}

func attentionCommands() []attentionCommandScenario {
	return []attentionCommandScenario{
		{"list", []string{"chat"}, []string{"/api/projects/project_1/sessions"}},
		{"detail", []string{"chat", "session_1"}, []string{"/api/projects/project_1/sessions/session_1"}},
		{"project", []string{"project"}, []string{"/api/projects/project_1"}},
		{"status", []string{"status"}, []string{"/api/projects/project_1", "/api/projects/project_1/sessions"}},
	}
}

func TestSessionAttentionCommandConsumers(t *testing.T) {
	for _, scenario := range attentionScenarios() {
		for _, command := range attentionCommands() {
			for _, mode := range []struct {
				name string
				json bool
			}{{"text", false}, {"json", true}} {
				t.Run(scenario.name+"/"+command.name+"/"+mode.name, func(t *testing.T) {
					session := sessionPayload(scenario.field)
					output := runAttentionCommand(t, command, session, mode.json)
					assertAttentionCommandOutput(t, command.name, output, session, mode.json)
				})
			}
		}
	}
}

func runAttentionCommand(t *testing.T, command attentionCommandScenario, session string, jsonMode bool) string {
	t.Helper()
	responses := map[string]string{
		"/api/projects/project_1":                    `{"id":"project_1","name":"Synthetic project","recentSessions":[` + session + `]}`,
		"/api/projects/project_1/sessions":           `{"sessions":[` + session + `]}`,
		"/api/projects/project_1/sessions/session_1": detailPayload(session),
	}
	var paths []string
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.Method != http.MethodGet {
			t.Errorf("method = %s", req.Method)
		}
		paths = append(paths, req.URL.Path)
		payload, ok := responses[req.URL.Path]
		if !ok {
			t.Errorf("unexpected path %s", req.URL.Path)
			return jsonResponse(`{}`, http.StatusNotFound), nil
		}
		return jsonResponse(payload, http.StatusOK), nil
	})
	args := append([]string(nil), command.args...)
	if jsonMode {
		args = append(args, "--json")
	}
	runtime, stdout, stderr := testRuntime(t, args, doer, activeProjectEnv(t))
	if code := Run(context.Background(), runtime); code != 0 || stderr.Len() != 0 {
		t.Fatalf("code=%d stderr=%s", code, stderr.String())
	}
	if !reflect.DeepEqual(paths, command.paths) {
		t.Fatalf("paths = %v, want %v", paths, command.paths)
	}
	return stdout.String()
}

func assertAttentionCommandOutput(t *testing.T, command, output, session string, jsonMode bool) {
	t.Helper()
	if jsonMode {
		assertAttentionCommandJSON(t, command, decodeAttentionJSON(t, []byte(output)), session)
		return
	}
	assertAttentionCommandText(t, command, output)
}

func assertAttentionCommandJSON(t *testing.T, command string, value map[string]any, session string) {
	t.Helper()
	switch command {
	case "list":
		assertRawSessionJSON(t, value["sessions"].([]any)[0], session)
	case "project":
		assertRawSessionJSON(t, value["recentSessions"].([]any)[0], session)
	case "status":
		assertRawSessionJSON(t, value["project"].(map[string]any)["recentSessions"].([]any)[0], session)
		assertRawSessionJSON(t, value["sessions"].(map[string]any)["sessions"].([]any)[0], session)
	case "detail":
		assertRawSessionJSON(t, value["session"], session)
		assertAttentionMessages(t, value, session)
	}
}

func assertAttentionCommandText(t *testing.T, command, output string) {
	t.Helper()
	switch command {
	case "project":
		assertAttentionTextContains(t, output, []string{"Synthetic project"})
	case "detail":
		assertAttentionTextContains(t, output, []string{
			"[user]", "[assistant]", "Synthetic question\nwith a second line",
			"Synthetic answer with <code> & Unicode: café",
			FormatAnyTimestamp(float64(1791500000123)), FormatAnyTimestamp("2026-10-09T03:27:09Z"),
		})
	default:
		assertAttentionTextContains(t, output, []string{"Synthetic example"})
	}
}

func assertAttentionTextContains(t *testing.T, output string, texts []string) {
	t.Helper()
	for _, text := range texts {
		if !strings.Contains(output, text) {
			t.Fatalf("missing %q in text output", text)
		}
	}
}

// Commands preserve the complete API object, including explicit null fields.
func assertRawSessionJSON(t *testing.T, got any, expected string) {
	t.Helper()
	want := decodeAttentionJSON(t, []byte(expected))
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("session JSON = %#v, want %#v", got, want)
	}
}
