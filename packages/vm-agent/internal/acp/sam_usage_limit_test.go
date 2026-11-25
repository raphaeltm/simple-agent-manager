package acp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// The bodies SAM's AI proxy sends with its own 429s (ai-proxy-admission.ts).
const (
	samAdminCapBody  = `{"error":{"message":"Administrator monthly AI spending limit reached. Contact your administrator or wait until next month.","type":"rate_limit_error","monthlyCost":{"usedUsd":5.01,"limitUsd":5}}}`
	samUserCapBody   = `{"error":{"message":"Monthly cost cap exceeded. Adjust your cap in Settings > Usage.","type":"rate_limit_error"}}`
	samDailyBody     = `{"error":{"message":"Daily token budget exceeded. Resets at midnight UTC.","type":"rate_limit_error"}}`
	providerRateBody = `{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}`
)

func wireRequestError(t *testing.T, wire string) *acpsdk.RequestError {
	t.Helper()
	var requestError acpsdk.RequestError
	if err := json.Unmarshal([]byte(wire), &requestError); err != nil {
		t.Fatal(err)
	}
	return &requestError
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func TestSAMUsageLimitRefusalIsNotAProviderOverload(t *testing.T) {
	for _, tc := range []struct {
		name, wire, want string
	}{
		{"Claude admin monthly ceiling", `{"code":-32603,"message":` + jsonString("Internal error: API Error: 429 "+samAdminCapBody) + `,"data":{"errorKind":"rate_limit"}}`, samUsageLimitReason},
		{"Claude user monthly cap, nested", `{"code":-32603,"message":"Internal error","data":{"errorKind":"rate_limit","message":` + jsonString("API Error: 429 "+samUserCapBody) + `}}`, samUsageLimitReason},
		{"Claude daily token budget", `{"code":-32603,"message":` + jsonString("Internal error: API Error: 429 "+samDailyBody) + `,"data":{"errorKind":"rate_limit"}}`, samUsageLimitReason},
		{"typed rate_limit without the status in the text", `{"code":-32603,"message":"Internal error","data":{"errorKind":"rate_limit","message":"Administrator monthly AI spending limit reached."}}`, samUsageLimitReason},
		{"Codex retry exhaustion on SAM's 429", `{"code":-32603,"message":"Internal error","data":{"codexErrorInfo":"usageLimitExceeded","message":` + jsonString("exceeded retry limit, last status: 429 Too Many Requests, "+samAdminCapBody) + `}}`, samUsageLimitReason},
		// Controls: hosted and self-hosted provider overloads keep their classification.
		{"control: provider rate limit", `{"code":-32603,"message":` + jsonString("Internal error: API Error: 429 "+providerRateBody) + `,"data":{"errorKind":"rate_limit"}}`, "provider_overloaded"},
		{"control: provider overloaded", `{"code":-32603,"message":"Internal error: API Error: 529 overloaded_error","data":{"errorKind":"overloaded"}}`, "provider_overloaded"},
		{"control: marker only in wrapper metadata", `{"code":-32603,"message":"Internal error","data":{"errorKind":"rate_limit","message":"API Error: 429 slow down","url":"https://evil.example/monthly ai spending limit reached 429"}}`, "provider_overloaded"},
		{"control: untyped top-level message echoing the marker", `{"code":-32603,"message":"tool said: daily token budget exceeded (429)","data":{}}`, ""},
		{"control: overloaded kind with the marker in echoed text", `{"code":-32603,"message":"Internal error","data":{"errorKind":"overloaded","message":"note: monthly cost cap exceeded, see 429 docs"}}`, "provider_overloaded"},
		{"control: marker in data.message under a specific top-level message", `{"code":-32603,"message":"Prompt failed","data":{"errorKind":"rate_limit","message":"API Error: 429 Monthly cost cap exceeded."}}`, "provider_overloaded"},
		{"control: request id containing 429", `{"code":-32603,"message":"Internal error","data":{"codexErrorInfo":"other","message":"request req_14290 failed: monthly cost cap exceeded"}}`, ""},
		{"control: not an internal error", `{"code":-32602,"message":` + jsonString("API Error: 429 "+samAdminCapBody) + `}`, ""},
		{"control: auth failure stays auth", `{"code":-32603,"message":"Internal error","data":{"errorKind":"authentication_failed","message":` + jsonString("API Error: 429 "+samAdminCapBody) + `}}`, "model_provider_credential_rejected"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ClassifyPromptError(wireRequestError(t, tc.wire)); got != tc.want {
				t.Fatalf("reason = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSAMUsageLimitTextPath(t *testing.T) {
	for _, tc := range []struct{ name, message, want string }{
		{"API error text", "API Error: 429 " + samAdminCapBody, samUsageLimitReason},
		{"provider text", "Provider HTTP 429 Monthly cost cap exceeded. Adjust your cap in Settings > Usage.", samUsageLimitReason},
		{"round-trip of the code", samUsageLimitReason, samUsageLimitReason},
		{"control: provider 429", "API Error: 429 " + providerRateBody, "provider_overloaded"},
		{"control: provider 503", "API Error: HTTP 503 overloaded", "provider_overloaded"},
		{"control: marker in a URL", "Provider HTTP 429 rate limit url=https://evil.example/monthly cost cap exceeded", "provider_overloaded"},
		{"control: marker without a provider prefix", "tool said monthly cost cap exceeded 429", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ClassifyPromptFailure(tc.message); got != tc.want {
				t.Fatalf("reason = %q, want %q", got, tc.want)
			}
		})
	}
}

// A Codex usageLimitExceeded normally means the provider plan limit and parks the task for
// its reset; SAM's own limit has no provider reset to wait for.
func TestSAMUsageLimitIsNotParkedAsAProviderPlanLimit(t *testing.T) {
	future := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	if limit := ClassifyProviderLimit(errors.New("API Error: 429 Monthly cost cap exceeded. "+future), time.Now()); limit != nil {
		t.Fatalf("SAM's limit text with a timestamp parked as a provider limit: %+v", limit)
	}
	if ClassifyProviderLimit(errors.New("API Error: 429 rate limited until "+future), time.Now()) == nil {
		t.Fatal("control: a provider 429 with a reset time must still park")
	}
	sam := wireRequestError(t, `{"code":-32603,"message":"Internal error","data":{"codexErrorInfo":"usageLimitExceeded","message":`+jsonString("last status: 429, "+samAdminCapBody)+`}}`)
	if limit := ClassifyProviderLimit(sam, time.Now()); limit != nil {
		t.Fatalf("SAM's limit classified as provider limit: %+v", limit)
	}
	plan := wireRequestError(t, `{"code":-32603,"message":"Internal error","data":{"codexErrorInfo":"usageLimitExceeded","message":"You've hit your usage limit."}}`)
	if ClassifyProviderLimit(plan, time.Now()) == nil {
		t.Fatal("control: a provider plan limit must still classify as one")
	}
}

// Through the prompt path the VM agent runs: the reason broadcast to the chat and handed to
// the task callback is the SAM limit code, never the provider's message.
func TestSAMUsageLimitPromptPathReportsTheLimitCode(t *testing.T) {
	host := newTestSessionHost(t)
	defer host.Stop()
	completed := make(chan error, 1)
	host.config.OnPromptComplete = func(_ string, promptErr error) { completed <- promptErr }
	host.finishPromptWithError(context.Background(), json.RawMessage(`"req-cap"`),
		promptStartInfo{startedAt: time.Now(), viewerID: "viewer-1"},
		wireRequestError(t, `{"code":-32603,"message":`+jsonString("Internal error: API Error: 429 "+samAdminCapBody)+`,"data":{"errorKind":"rate_limit"}}`))
	select {
	case promptErr := <-completed:
		if got := ClassifyPromptError(promptErr); got != samUsageLimitReason {
			t.Fatalf("prompt callback reason = %q, want %q", got, samUsageLimitReason)
		}
	case <-time.After(time.Second):
		t.Fatal("prompt completion callback not called")
	}
	host.bufMu.RLock()
	defer host.bufMu.RUnlock()
	found := false
	for _, buffered := range host.messageBuf {
		found = found || strings.Contains(string(buffered.Data), samUsageLimitReason)
	}
	if !found {
		t.Fatal("prompt did not broadcast the SAM usage limit reason")
	}
}
