package server

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/workspace/vm-agent/internal/config"
)

func TestPinnedAdapterWireErrorTaskCallbackSanitizer(t *testing.T) {
	const canary = "sk-secret-canary-123456789"
	for _, tc := range []struct{ name, wire, want string }{
		{"Claude provider 401", `{"code":-32603,"message":"Internal error","data":{"errorKind":"authentication_failed","message":"API Error: 401","url":"https://evil.example/?token=` + canary + `"}}`, "model_provider_credential_rejected"},
		{"Codex configured provider unauthorized", `{"code":-32603,"message":"Internal error","data":{"message":"API Error: 401 ` + canary + `","codexErrorInfo":"unauthorized"}}`, "model_provider_credential_rejected"},
		{"MCP 401 without source", `{"code":-32603,"message":"Internal error","data":{"message":"MCP HTTP 401 ` + canary + `"}}`, "agent_prompt_failed"},
		{"unsupported 400 without model source", `{"code":-32603,"message":"Internal error","data":{"message":"API Error: 400 unsupported_model ` + canary + `","codexErrorInfo":"badRequest"}}`, "agent_prompt_failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var requestError acpsdk.RequestError
			if err := json.Unmarshal([]byte(tc.wire), &requestError); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(requestError.Error(), canary) {
				t.Fatal("SDK Error() did not include test canary")
			}
			body := runTaskCompletionCallback(t, config.TaskModeTask, "error", &requestError)
			if body["errorMessage"] != tc.want || body["toStatus"] != "failed" {
				t.Fatalf("callback = %#v, want reason %q", body, tc.want)
			}
			if encoded, _ := json.Marshal(body); strings.Contains(string(encoded), canary) || strings.Contains(string(encoded), "evil.example") {
				t.Fatal("task callback leaked untrusted SDK metadata")
			}
		})
	}
}

func TestTaskCallbackAuthFailureUsesOnlyReasonCode(t *testing.T) {
	const canary = "sk-secret-canary-123456789"
	got := taskCallbackErrorMessage(errors.New("Provider HTTP 400 unsupported_model url=https://example.test/?token=" + canary))
	if got != "model_unavailable" || strings.Contains(got, canary) || strings.Contains(got, "example.test") {
		t.Fatalf("unsafe callback reason: %q", got)
	}
}

func TestTaskCallbackPinnedSDKErrorUsesOnlyReasonCode(t *testing.T) {
	const canary = "sk-secret-canary-123456789"
	err := acpsdk.NewInternalError(map[string]any{
		"errorKind": "model_not_found",
		"error":     "API Error: 401 invalid authentication",
		"url":       "https://evil.example/?token=" + canary,
	})
	if got := taskCallbackErrorMessage(err); got != "model_unavailable" || strings.Contains(got, canary) {
		t.Fatalf("unsafe SDK callback reason: %q", got)
	}
}

func TestTaskCallbackPinnedSDKErrorOnlyMetadataStaysGeneric(t *testing.T) {
	const canary = "sk-secret-canary-123456789"
	err := acpsdk.NewInternalError(map[string]any{
		"error": "API Error: 400 unsupported_model with ChatGPT account",
		"url":   "https://evil.example/?token=" + canary,
	})
	body := runTaskCompletionCallback(t, config.TaskModeTask, "error", err)
	if body["errorMessage"] != "agent_prompt_failed" || body["toStatus"] != "failed" {
		t.Fatalf("untrusted SDK metadata changed callback result: %#v", body)
	}
	if encoded, _ := json.Marshal(body); strings.Contains(string(encoded), canary) || strings.Contains(string(encoded), "evil.example") {
		t.Fatal("untrusted SDK metadata leaked in callback")
	}
}

func TestTaskCallbackUnknownFailureIsSafe(t *testing.T) {
	const canary = "sk-secret-canary-123456789"
	got := taskCallbackErrorMessage(errors.New("Unknown wrapper failure https://example.test/?token=" + canary))
	if got != "agent_prompt_failed" {
		t.Fatalf("unsafe callback fallback: %q", got)
	}
}

func TestTaskCallbackPreservesOnlyTypedMissingCredential(t *testing.T) {
	for _, tc := range []struct{ message, want string }{
		{"model_provider_credential_missing", "model_provider_credential_missing"},
		{"agent_key_fetch: no credential configured", "agent_prompt_failed"},
	} {
		body := runTaskCompletionCallback(t, config.TaskModeTask, "error", errors.New(tc.message))
		if body["errorMessage"] != tc.want {
			t.Fatalf("callback errorMessage = %v, want %q", body["errorMessage"], tc.want)
		}
	}
}

func TestTaskCallbackRetainsSafeNonAuthDiagnosis(t *testing.T) {
	const canary = "sk-secret-canary-123456789"
	for _, tc := range []struct{ message, want string }{
		{"Provider HTTP 429 rate limit token=" + canary, "provider_overloaded"},
		{"Network error: connection reset token=" + canary, "network_error"},
		{"Agent process exited unexpectedly token=" + canary, "agent_crash"},
	} {
		got := taskCallbackErrorMessage(errors.New(tc.message))
		if got != tc.want || strings.Contains(got, canary) {
			t.Fatalf("message %q: got %q, want %q", tc.message, got, tc.want)
		}
	}
}
