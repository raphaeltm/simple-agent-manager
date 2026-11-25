package acp

import (
	"errors"
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

// isSAMUsageLimitText reports a 429 whose message is a SAM AI proxy limit refusal.
// A provider's own 429 (rate limit, overload) never carries these sentences, so a
// real overload keeps classifying as provider_overloaded.
func isSAMUsageLimitText(message string) bool {
	return strings.Contains(message, "429") && hasSAMUsageLimitMarker(message)
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
	// Claude's typed rate_limit already says the status was 429.
	return isSAMUsageLimitText(message) || (data["errorKind"] == "rate_limit" && hasSAMUsageLimitMarker(message))
}
