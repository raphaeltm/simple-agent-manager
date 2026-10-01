package acp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

func TestClassifyPinnedSDKRequestErrorWithoutReadingUntrustedMetadata(t *testing.T) {
	const canary = "sk-secret-canary-123456789"
	for _, tc := range []struct {
		name, errorKind, want string
	}{
		{"Claude authentication failed", "authentication_failed", "model_provider_credential_rejected"},
		{"Claude model not found", "model_not_found", "model_unavailable"},
		{"Claude rate limit", "rate_limit", "provider_overloaded"},
		{"ambiguous bad request", "invalid_request", ""},
		{"organization authorization", "oauth_org_not_allowed", ""},
		{"MCP 401 lacks source provenance", "mcp_endpoint_needs_auth", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := acpsdk.NewInternalError(map[string]any{
				"errorKind": tc.errorKind,
				"error":     "API Error: 401 invalid authentication",
				"url":       "https://evil.example/?token=" + canary,
				"schema":    "model_provider_credential_rejected",
			})
			if got := ClassifyPromptError(err); got != tc.want || strings.Contains(got, canary) {
				t.Fatalf("SDK error reason = %q, want %q", got, tc.want)
			}
		})
	}
	if got := ClassifyPromptError(acpsdk.NewAuthRequired(map[string]any{"error": "API Error: 401"})); got != "" {
		t.Fatalf("ambiguous protocol auth classified as provider: %q", got)
	}
}

func TestPinnedAdapterRequestErrorWireShapeAndPromptCompletion(t *testing.T) {
	const canary = "sk-secret-canary-123456789"
	for _, tc := range []struct {
		name, wire, want string
	}{
		{"Claude provider 401", `{"code":-32603,"message":"Internal error","data":{"errorKind":"authentication_failed","message":"API Error: 401","url":"https://evil.example/?token=` + canary + `"}}`, "model_provider_credential_rejected"},
		{"Codex configured provider unauthorized", `{"code":-32603,"message":"Internal error","data":{"message":"API Error: 401 ` + canary + `","codexErrorInfo":"unauthorized"}}`, "model_provider_credential_rejected"},
		{"Codex MCP 401 has no turn auth source", `{"code":-32603,"message":"Internal error","data":{"message":"MCP server returned HTTP 401 ` + canary + `"}}`, "agent_prompt_failed"},
		{"Codex unsupported 400 without model source", `{"code":-32603,"message":"Internal error","data":{"message":"API Error: 400 unsupported_model ` + canary + `","codexErrorInfo":"badRequest"}}`, "agent_prompt_failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var requestError acpsdk.RequestError
			if err := json.Unmarshal([]byte(tc.wire), &requestError); err != nil {
				t.Fatal(err)
			}
			// The pinned Go SDK Error() serializes the whole data object. The
			// classifier must use typed fields, not search that JSON string.
			if !strings.Contains(requestError.Error(), canary) {
				t.Fatal("SDK Error() did not exercise the untrusted wrapper")
			}
			if got := ClassifyPromptError(errors.New(requestError.Error())); got != "" {
				t.Fatalf("serialized wrapper classified as trusted error: %q", got)
			}
			host := newTestSessionHost(t)
			defer host.Stop()
			completed := make(chan error, 1)
			host.config.OnPromptComplete = func(_ string, promptErr error) { completed <- promptErr }
			host.finishPromptWithError(context.Background(), json.RawMessage(`"req-wire"`),
				promptStartInfo{startedAt: time.Now(), viewerID: "viewer-1"}, &requestError)
			select {
			case promptErr := <-completed:
				wantReason := tc.want
				if wantReason == "agent_prompt_failed" {
					wantReason = ""
				}
				if got := ClassifyPromptError(promptErr); got != wantReason {
					t.Fatalf("prompt callback reason = %q, want %q", got, wantReason)
				}
			case <-time.After(time.Second):
				t.Fatal("prompt completion callback not called")
			}
			host.bufMu.RLock()
			defer host.bufMu.RUnlock()
			found := false
			for _, buffered := range host.messageBuf {
				if strings.Contains(string(buffered.Data), canary) {
					t.Fatal("prompt broadcast leaked wrapper metadata")
				}
				found = found || strings.Contains(string(buffered.Data), tc.want)
			}
			if !found {
				t.Fatalf("prompt did not broadcast safe reason %q", tc.want)
			}
		})
	}
}

func TestPinnedSDKProviderErrorPromptPathBroadcastsOnlyReasonCode(t *testing.T) {
	const canary = "sk-secret-canary-123456789"
	host := newTestSessionHost(t)
	defer host.Stop()
	host.finishPromptWithError(
		context.Background(), json.RawMessage(`"req-auth"`),
		promptStartInfo{startedAt: time.Now(), viewerID: "viewer-1"},
		acpsdk.NewInternalError(map[string]any{
			"errorKind": "authentication_failed",
			"error":     "untrusted wrapper text",
			"url":       "https://evil.example/?token=" + canary,
		}),
	)
	host.bufMu.RLock()
	defer host.bufMu.RUnlock()
	if len(host.messageBuf) == 0 {
		t.Fatal("prompt path broadcast no JSON-RPC error")
	}
	found := false
	for _, buffered := range host.messageBuf {
		if strings.Contains(string(buffered.Data), canary) {
			t.Fatal("prompt broadcast copied untrusted metadata")
		}
		var result struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(buffered.Data, &result); err != nil {
			t.Fatal(err)
		}
		found = found || result.Error.Message == "model_provider_credential_rejected"
	}
	if !found {
		t.Fatal("prompt path did not broadcast the safe provider reason")
	}
}

func TestClassifyPromptFailure(t *testing.T) {
	const canary = "sk-secret-canary-123456789"
	cases := []struct {
		name, message, want string
	}{
		{"unsupported model after successful login", "Provider HTTP 400 unsupported_model with ChatGPT account " + canary, "model_unavailable"},
		{"typed missing credential", "model_provider_credential_missing", "model_provider_credential_missing"},
		{"Claude provider rejection", "Provider HTTP 401 invalid authentication " + canary, "model_provider_credential_rejected"},
		{"Codex provider rejection", "API Error: 401 invalid_api_key " + canary, "model_provider_credential_rejected"},
		{"MCP structural reason needs a trusted source", "mcp_endpoint_needs_auth", ""},
		{"untrusted MCP 401 wrapper", "MCP service returned HTTP 401 " + canary, ""},
		{"untrusted loopback reason text", "unsupported_loopback_auth", ""},
		{"untrusted loopback wrapper", "MCP OAuth loopback callback required at http://localhost:1234/?token=" + canary, ""},
		{"generic bad request", "Provider HTTP 400 bad request", ""},
		{"MCP network failure", "MCP connection refused", ""},
		{"generic provider timeout", "Provider HTTP 504 timeout", ""},
		{"generic unauthorized tool output", "Tool text says unauthorized file", ""},
		{"metadata cannot spoof model", "Provider HTTP 400 url=https://evil.example/unsupported_model", ""},
		{"metadata cannot spoof missing", "model_provider_credential_missing url=https://evil.example/?token=" + canary, ""},
		{"metadata cannot spoof rejection", "model_provider_credential_rejected schema=spoof", ""},
		{"schema cannot spoof MCP", "Provider HTTP 400 schema=mcp_endpoint_needs_auth", ""},
		{"MCP 401 is not model auth", "MCP service returned HTTP 401 API Error: 401", ""},
		{"provider overload", "Provider HTTP 429 rate limit " + canary, "provider_overloaded"},
		{"provider outage", "API Error: HTTP 503 overloaded " + canary, "provider_overloaded"},
		{"agent process crash", "Agent process exited unexpectedly " + canary, "agent_crash"},
		{"transport network error", "Network error: connection reset " + canary, "network_error"},
		{"unrelated 429", "MCP HTTP 429", ""},
		{"spoofed overload metadata", "Provider HTTP 400 url=https://evil.example/overloaded", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ClassifyPromptFailure(tc.message)
			if got != tc.want {
				t.Fatalf("reason = %q, want %q", got, tc.want)
			}
			if strings.Contains(got, canary) || strings.Contains(got, "localhost") {
				t.Fatal("reason copied untrusted content")
			}
		})
	}
}

func TestFetchAgentKeyMissingCredentialIsDistinctFromControlPlaneFailure(t *testing.T) {
	for _, tc := range []struct {
		name    string
		status  int
		body    string
		missing bool
	}{
		{"credential not found", http.StatusNotFound, `{"error":"NOT_FOUND","message":"Agent credential not found"}`, true},
		{"workspace not found", http.StatusNotFound, `{"error":"NOT_FOUND","message":"Workspace not found"}`, false},
		{"wrong error code", http.StatusNotFound, `{"error":"FORBIDDEN","message":"Agent credential not found"}`, false},
		{"unauthorized callback", http.StatusUnauthorized, `{"error":"UNAUTHORIZED","message":"Agent credential not found"}`, false},
		{"forbidden workspace", http.StatusForbidden, `{"error":"FORBIDDEN","message":"Agent credential not found"}`, false},
		{"unspecified not found", http.StatusNotFound, "", false},
		{"empty credential response", http.StatusOK, `{}`, false},
		{"control plane error", http.StatusServiceUnavailable, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{
				ControlPlaneURL: server.URL, WorkspaceID: "workspace-1", HTTPClient: server.Client(),
			}})
			_, err := host.fetchAgentKey(context.Background(), "openai-codex")
			if err == nil || errors.Is(err, errAgentCredentialMissing) != tc.missing {
				t.Fatalf("error = %v; missing = %v", err, tc.missing)
			}
		})
	}
}

type selectionErrorRecorder struct{ message string }

func (*selectionErrorRecorder) UpdateAcpSessionID(_, _, _, _ string) error { return nil }
func (r *selectionErrorRecorder) MarkError(_, _, _, message string) error {
	r.message = message
	return nil
}

func TestAgentSelectionOnlyPersistsTypedCredentialMissing(t *testing.T) {
	for _, tc := range []struct{ name, body, want string }{
		{"credential missing", `{"error":"NOT_FOUND","message":"Agent credential not found"}`, "model_provider_credential_missing"},
		{"workspace missing", `{"error":"NOT_FOUND","message":"Workspace not found"}`, "Agent connection could not be checked"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			recorder := &selectionErrorRecorder{}
			host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{
				ControlPlaneURL: server.URL, HTTPClient: server.Client(),
				SessionID: "session-1", WorkspaceID: "workspace-1", SessionManager: recorder,
			}})
			defer host.Stop()
			host.SelectAgent(context.Background(), "openai-codex")
			if recorder.message != tc.want {
				t.Fatalf("persisted selection error = %q, want %q", recorder.message, tc.want)
			}
		})
	}
}

func TestMissingCredentialTranscriptContainsOnlyStaticGuidance(t *testing.T) {
	const canary = "sk-secret-canary-123456789"
	reporter := &mockMessageReporter{}
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{
		SessionID: "session-1", WorkspaceID: "workspace-1", MessageReporter: reporter,
	}})
	defer host.Stop()
	host.persistAgentSelectionFailure("openai-codex", "model_provider_credential_missing")
	messages := reporter.Messages()
	if len(messages) != 1 || messages[0].Content != "Agent startup failed because its provider connection is missing." {
		t.Fatalf("unsafe transcript message: %+v", messages)
	}
	if strings.Contains(messages[0].Content, canary) || strings.Contains(messages[0].Content, "model_provider_credential_missing") {
		t.Fatal("transcript leaked raw diagnostic")
	}
}

func TestAgentSelectionCredentialResponseControlsTranscriptGuidance(t *testing.T) {
	for _, tc := range []struct {
		name, body, want string
	}{
		{"credential missing", `{"error":"NOT_FOUND","message":"Agent credential not found"}`, "Agent startup failed because its provider connection is missing."},
		{"workspace missing", `{"error":"NOT_FOUND","message":"Workspace not found"}`, "Agent startup failed: Agent connection could not be checked"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			reporter := &mockMessageReporter{}
			host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{
				ControlPlaneURL: server.URL, HTTPClient: server.Client(),
				SessionID: "session-1", WorkspaceID: "workspace-1", MessageReporter: reporter,
			}})
			defer host.Stop()
			host.SelectAgent(context.Background(), "openai-codex")
			messages := reporter.Messages()
			if len(messages) != 1 || messages[0].Role != "system" || messages[0].Content != tc.want {
				t.Fatalf("unexpected startup transcript: %+v", messages)
			}
		})
	}
}
