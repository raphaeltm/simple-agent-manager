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
			for _, detail := range []bool{false, true} {
				payload := `{"sessions":[` + session + `]}`
				path := "/api/projects/project_1/sessions"
				if detail {
					payload = detailPayload(session)
					path += "/session_1"
				}
				doer, captured := captureJSONRequest(t, payload, http.StatusOK)
				client := NewAPIClient(CLIConfig{APIURL: "https://api.example.com"}, doer)
				var decoded Session
				if detail {
					response, err := client.GetSessionDetail(context.Background(), "project_1", "session_1")
					if err != nil {
						t.Fatal(err)
					}
					decoded = response.Session
					if !response.HasMore || len(response.Messages) != 2 || response.Messages[0].Role != "user" || response.Messages[1].Role != "assistant" || response.Messages[0].Content != "Synthetic question\nwith a second line" || response.Messages[1].CreatedAt != "2026-10-09T03:27:09Z" {
						t.Fatalf("detail fields changed: %#v", response)
					}
				} else {
					response, err := client.ListSessions(context.Background(), "project_1")
					if err != nil {
						t.Fatal(err)
					}
					if len(response.Sessions) != 1 {
						t.Fatal("expected one session")
					}
					decoded = response.Sessions[0]
				}
				if captured.Method != http.MethodGet || captured.URL != "https://api.example.com"+path {
					t.Fatalf("unexpected request: %#v", captured)
				}
				data, err := json.Marshal(decoded)
				if err != nil {
					t.Fatal(err)
				}
				var value any
				if err := json.Unmarshal(data, &value); err != nil {
					t.Fatal(err)
				}
				assertSessionJSON(t, value, session)
			}
		})
	}
}

func TestSessionAttentionCommandConsumers(t *testing.T) {
	for _, scenario := range attentionScenarios() {
		for _, command := range []string{"list", "detail", "project", "status"} {
			for _, jsonMode := range []bool{false, true} {
				name := scenario.name + "/" + command
				if jsonMode {
					name += "/json"
				} else {
					name += "/text"
				}
				t.Run(name, func(t *testing.T) {
					session := sessionPayload(scenario.field)
					list := `{"sessions":[` + session + `]}`
					project := `{"id":"project_1","name":"Synthetic project","recentSessions":[` + session + `]}`
					args := []string{"chat"}
					switch command {
					case "detail":
						args = append(args, "session_1")
					case "project":
						args = []string{"project"}
					case "status":
						args = []string{"status"}
					}
					if jsonMode {
						args = append(args, "--json")
					}
					var paths []string
					doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
						if req.Method != http.MethodGet {
							t.Errorf("method = %s", req.Method)
						}
						paths = append(paths, req.URL.Path)
						switch req.URL.Path {
						case "/api/projects/project_1":
							return jsonResponse(project, http.StatusOK), nil
						case "/api/projects/project_1/sessions":
							return jsonResponse(list, http.StatusOK), nil
						case "/api/projects/project_1/sessions/session_1":
							return jsonResponse(detailPayload(session), http.StatusOK), nil
						default:
							t.Errorf("unexpected path %s", req.URL.Path)
							return jsonResponse(`{}`, http.StatusNotFound), nil
						}
					})
					runtime, stdout, stderr := testRuntime(t, args, doer, activeProjectEnv(t))
					if code := Run(context.Background(), runtime); code != 0 || stderr.Len() != 0 {
						t.Fatalf("code=%d stderr=%s", code, stderr.String())
					}
					wantPaths := []string{"/api/projects/project_1/sessions"}
					switch command {
					case "detail":
						wantPaths[0] += "/session_1"
					case "project":
						wantPaths[0] = "/api/projects/project_1"
					case "status":
						wantPaths = []string{"/api/projects/project_1", "/api/projects/project_1/sessions"}
					}
					if !reflect.DeepEqual(paths, wantPaths) {
						t.Fatalf("paths = %v, want %v", paths, wantPaths)
					}
					if !jsonMode {
						want := "Synthetic example"
						if command == "project" {
							want = "Synthetic project"
						}
						if command == "detail" {
							for _, text := range []string{"[user]", "[assistant]", "Synthetic question\nwith a second line", "Synthetic answer with <code> & Unicode: café", FormatAnyTimestamp(float64(1791500000123)), FormatAnyTimestamp("2026-10-09T03:27:09Z")} {
								if !strings.Contains(stdout.String(), text) {
									t.Fatalf("missing %q in text output", text)
								}
							}
							return
						}
						if !strings.Contains(stdout.String(), want) {
							t.Fatalf("missing %q in text output", want)
						}
						return
					}
					var value map[string]any
					if err := json.Unmarshal(stdout.Bytes(), &value); err != nil {
						t.Fatal(err)
					}
					switch command {
					case "list":
						assertSessionJSON(t, value["sessions"].([]any)[0], session)
					case "project":
						assertSessionJSON(t, value["recentSessions"].([]any)[0], session)
					case "status":
						assertSessionJSON(t, value["project"].(map[string]any)["recentSessions"].([]any)[0], session)
						assertSessionJSON(t, value["sessions"].(map[string]any)["sessions"].([]any)[0], session)
					case "detail":
						assertSessionJSON(t, value["session"], session)
						var expected map[string]any
						if err := json.Unmarshal([]byte(detailPayload(session)), &expected); err != nil {
							t.Fatal(err)
						}
						if !reflect.DeepEqual(value["messages"], expected["messages"]) || value["hasMore"] != true {
							t.Fatal("message roles, content, timestamps or hasMore changed")
						}
					}
				})
			}
		}
	}
}
