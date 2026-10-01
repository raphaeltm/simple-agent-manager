package server

import (
	"errors"
	"strings"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
)

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
	if got := taskCallbackErrorMessage(err); got != "agent_prompt_failed" || strings.Contains(got, canary) {
		t.Fatalf("untrusted SDK metadata changed callback reason: %q", got)
	}
}

func TestTaskCallbackUnknownFailureIsSafe(t *testing.T) {
	const canary = "sk-secret-canary-123456789"
	got := taskCallbackErrorMessage(errors.New("Unknown wrapper failure https://example.test/?token=" + canary))
	if got != "agent_prompt_failed" {
		t.Fatalf("unsafe callback fallback: %q", got)
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
