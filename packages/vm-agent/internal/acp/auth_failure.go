package acp

import "strings"

// ClassifyPromptFailure extracts only a stable reason code from a prompt
// error. Wrapper error strings are untrusted and may contain URLs or tokens;
// callers must never include the original string in diagnostic payloads after
// this function recognizes it.
func ClassifyPromptFailure(message string) string {
	text := strings.ToLower(strings.TrimSpace(strings.SplitN(message, "\n", 2)[0]))
	for _, marker := range []string{" url=", " schema=", " https://", " http://"} {
		if at := strings.Index(text, marker); at >= 0 {
			text = text[:at]
		}
	}
	if text == "model_unavailable" ||
		((strings.HasPrefix(text, "provider ") || strings.HasPrefix(text, "api error: ") || strings.HasPrefix(text, "internal error: api error: ")) &&
			(strings.Contains(text, "unsupported_model") || strings.Contains(text, "model_not_supported") ||
				(strings.Contains(text, "model") && (strings.Contains(text, "not supported") || strings.Contains(text, "not available for"))))) {
		return "model_unavailable"
	}
	if text == "mcp_endpoint_needs_auth" {
		return "mcp_endpoint_needs_auth"
	}
	if text == "model_provider_credential_rejected" ||
		(strings.HasPrefix(text, "provider ") && (strings.Contains(text, "http 401") || strings.Contains(text, "invalid_api_key") || strings.Contains(text, "invalid authentication"))) ||
		(strings.HasPrefix(text, "api error: 401") || strings.HasPrefix(text, "internal error: api error: 401")) {
		return "model_provider_credential_rejected"
	}
	if text == "provider_overloaded" ||
		((strings.HasPrefix(text, "provider ") || strings.HasPrefix(text, "api error: ") || strings.HasPrefix(text, "internal error: api error: ")) &&
			(strings.Contains(text, "http 429") || strings.Contains(text, "http 529") || strings.Contains(text, "http 503") || strings.Contains(text, "rate limit") || strings.Contains(text, "overloaded"))) {
		return "provider_overloaded"
	}
	if text == "agent_crash" || strings.HasPrefix(text, "agent process exited") || strings.HasPrefix(text, "agent process crashed") || strings.HasPrefix(text, "acp peer disconnected") {
		return "agent_crash"
	}
	if text == "network_error" || strings.HasPrefix(text, "network error:") || strings.HasPrefix(text, "network failure:") || strings.HasPrefix(text, "provider network error:") {
		return "network_error"
	}
	return ""
}
