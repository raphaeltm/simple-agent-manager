package acp

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClassifyPromptFailure(t *testing.T) {
	const canary = "sk-secret-canary-123456789"
	cases := []struct {
		name, message, want string
	}{
		{"unsupported model after successful login", "Provider HTTP 400 unsupported_model with ChatGPT account " + canary, "model_unavailable"},
		{"Claude provider rejection", "Provider HTTP 401 invalid authentication " + canary, "model_provider_credential_rejected"},
		{"Codex provider rejection", "API Error: 401 invalid_api_key " + canary, "model_provider_credential_rejected"},
		{"MCP structural reason", "mcp_endpoint_needs_auth", "mcp_endpoint_needs_auth"},
		{"untrusted MCP 401 wrapper", "MCP service returned HTTP 401 " + canary, ""},
		{"untrusted loopback reason text", "unsupported_loopback_auth", ""},
		{"untrusted loopback wrapper", "MCP OAuth loopback callback required at http://localhost:1234/?token=" + canary, ""},
		{"generic bad request", "Provider HTTP 400 bad request", ""},
		{"MCP network failure", "MCP connection refused", ""},
		{"generic provider timeout", "Provider HTTP 504 timeout", ""},
		{"generic unauthorized tool output", "Tool text says unauthorized file", ""},
		{"metadata cannot spoof model", "Provider HTTP 400 url=https://evil.example/unsupported_model", ""},
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
