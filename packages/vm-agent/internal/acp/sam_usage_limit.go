package acp

import (
	"errors"
	"regexp"
	"strings"

	acpsdk "github.com/coder/acp-go-sdk"
)

// samUsageLimitReason is the prompt failure code for a refusal by SAM's own AI proxy
// spending or token limit. The UI maps it to "SAM AI usage limit reached"
// (packages/shared/src/failure-classification.ts), not to a provider overload:
// retrying does not help until the limit resets or an administrator changes it.
const samUsageLimitReason = "sam_ai_usage_limit_reached"

// samUsageLimitMarkers are the messages the SAM AI proxy returns with HTTP 429 when
// its own limit refuses a call. Keep in sync with monthlyCostCapMessage
// (packages/ai-proxy/src/ai-monthly-cost-cap.ts) and the daily token budget refusal
// (apps/api/src/routes/ai-proxy-admission.ts); apps/api tests pin the TS side.
var samUsageLimitMarkers = []string{
	"monthly ai spending limit reached",
	"monthly cost cap exceeded",
	"daily token budget exceeded",
}

func hasSAMUsageLimitMarker(message string) bool {
	text := strings.ToLower(message)
	for _, marker := range samUsageLimitMarkers {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}

// status429 is a standalone 429 (not part of a longer number such as a request id).
var status429 = regexp.MustCompile(`(^|[^0-9])429([^0-9]|$)`)

// isSAMUsageLimitText reports a 429 whose message is a SAM AI proxy limit refusal.
// A provider's own 429 (rate limit, overload) never carries these sentences, so a
// real overload keeps classifying as provider_overloaded.
func isSAMUsageLimitText(message string) bool {
	return status429.MatchString(message) && hasSAMUsageLimitMarker(message)
}

// apiError429 is the terminal API error prefix the pinned adapters give an HTTP 429.
func apiError429(message string) bool {
	text := strings.ToLower(message)
	for _, prefix := range []string{internalAPIErrorPrefix + "429", apiErrorPrefix + "429"} {
		if strings.HasPrefix(text, prefix) {
			return true
		}
	}
	return false
}

// isSAMUsageLimitRequestError reads only the terminal error message fields the
// adapters put the API error in (RequestError.Message, or data.message under a
// generic "Internal error"), never other wrapper metadata such as URLs or schemas.
func isSAMUsageLimitRequestError(err error) bool {
	var request *acpsdk.RequestError
	if !errors.As(err, &request) || request.Code != -32603 {
		return false
	}
	data, _ := request.Data.(map[string]any)
	if data["errorKind"] == "authentication_failed" || data["codexErrorInfo"] == "unauthorized" {
		return false
	}
	message := request.Message
	if message == "Internal error" {
		message, _ = data["message"].(string)
	}
	if !hasSAMUsageLimitMarker(message) {
		return false
	}
	// Structured evidence that this was an HTTP 429 from the model endpoint, as the
	// provider-limit classifier requires: Claude's typed rate_limit, a Codex turn
	// error, or the adapter's own "API Error: 429" prefix. A marker in arbitrary
	// echoed text is not enough.
	_, codex := data["codexErrorInfo"].(string)
	return data["errorKind"] == "rate_limit" || (codex && isSAMUsageLimitText(message)) || apiError429(message)
}
