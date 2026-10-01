package acp

import (
	"errors"
	"strings"

	acpsdk "github.com/coder/acp-go-sdk"
)

// ClassifyPromptError reads the pinned SDK's top-level session/prompt error shape.
// Its Error() method serializes data as JSON, so matching that whole string
// would either miss provider failures or let untrusted metadata spoof one.
// MCP tool errors without explicit source evidence stay generic.
func ClassifyPromptError(err error) string {
	if err == nil {
		return ""
	}
	var requestError *acpsdk.RequestError
	if errors.As(err, &requestError) {
		if requestError.Code != -32603 || requestError.Message != "Internal error" {
			return ""
		}
		data, ok := requestError.Data.(map[string]any)
		if !ok {
			return ""
		}
		// codex-acp 1.13.1 attaches codexErrorInfo to terminal turn
		// RequestErrors when auth was already configured. MCP startup failures
		// arrive as tool-call text instead and cannot reach this branch.
		if codexErrorInfo, ok := data["codexErrorInfo"].(string); ok && codexErrorInfo == "unauthorized" {
			return "model_provider_credential_rejected"
		}
		// claude-agent-acp 0.81.2 attaches this categorical field to
		// RequestError.internalError. Other data is untrusted wrapper metadata.
		switch data["errorKind"] {
		case "authentication_failed":
			return "model_provider_credential_rejected"
		case "model_not_found":
			return "model_unavailable"
		case "rate_limit", "overloaded":
			return "provider_overloaded"
		default:
			return ""
		}
	}
	return ClassifyPromptFailure(err.Error())
}

// ClassifyPromptFailure extracts only a stable reason code from a prompt
// error. Wrapper error strings are untrusted and may contain URLs or tokens;
// callers must never include the original string in diagnostic payloads after
// this function recognizes it.
func ClassifyPromptFailure(message string) string {
	text := strings.ToLower(strings.TrimSpace(strings.SplitN(message, "\n", 2)[0]))
	switch text {
	case "model_provider_credential_missing", "model_provider_credential_rejected", "model_unavailable", "provider_overloaded", "agent_crash", "network_error":
		return text
	}
	for _, marker := range []string{" url=", " schema=", " https://", " http://"} {
		if at := strings.Index(text, marker); at >= 0 {
			text = text[:at]
		}
	}
	if (strings.HasPrefix(text, "provider ") || strings.HasPrefix(text, "api error: ") || strings.HasPrefix(text, "internal error: api error: ")) &&
		(strings.Contains(text, "unsupported_model") || strings.Contains(text, "model_not_supported") ||
			(strings.Contains(text, "model") && (strings.Contains(text, "not supported") || strings.Contains(text, "not available for")))) {
		return "model_unavailable"
	}
	if (strings.HasPrefix(text, "provider ") && (strings.Contains(text, "http 401") || strings.Contains(text, "invalid_api_key") || strings.Contains(text, "invalid authentication"))) ||
		(strings.HasPrefix(text, "api error: 401") || strings.HasPrefix(text, "internal error: api error: 401")) {
		return "model_provider_credential_rejected"
	}
	if (strings.HasPrefix(text, "provider ") || strings.HasPrefix(text, "api error: ") || strings.HasPrefix(text, "internal error: api error: ")) &&
		(strings.Contains(text, "http 429") || strings.Contains(text, "http 529") || strings.Contains(text, "http 503") || strings.Contains(text, "rate limit") || strings.Contains(text, "overloaded")) {
		return "provider_overloaded"
	}
	if strings.HasPrefix(text, "agent process exited") || strings.HasPrefix(text, "agent process crashed") || strings.HasPrefix(text, "acp peer disconnected") {
		return "agent_crash"
	}
	if strings.HasPrefix(text, "network error:") || strings.HasPrefix(text, "network failure:") || strings.HasPrefix(text, "provider network error:") {
		return "network_error"
	}
	return ""
}
