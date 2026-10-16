package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

func TestProviderLimitActualClaudeGatewayFixture(t *testing.T) {
	encoded, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "tests", "fixtures", "provider-limit-rejections.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Now   string `json:"now"`
		Cases []struct {
			Name string              `json:"name"`
			Wire acpsdk.RequestError `json:"wire"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(encoded, &fixture); err != nil {
		t.Fatal(err)
	}
	now, err := time.Parse(time.RFC3339, fixture.Now)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range fixture.Cases {
		if tc.Name != "Claude gateway SDK wrapper" {
			continue
		}
		limit := ClassifyProviderLimit(&tc.Wire, now)
		if limit == nil || limit.ResetsAt == nil || *limit.ResetsAt != time.Date(2026, 8, 14, 13, 0, 0, 0, time.UTC).UnixMilli() {
			t.Fatal("actual pinned adapter reset-bearing rejection was not classified")
		}
		return
	}
	t.Fatal("actual adapter fixture missing")
}

func TestProviderLimitGatewayUnknownReset(t *testing.T) {
	now := time.Date(2026, 8, 14, 5, 0, 0, 0, time.UTC)
	for _, plan := range []string{"You've hit your session limit", "You've hit your weekly limit"} {
		request := &acpsdk.RequestError{Code: -32603, Message: "Internal error: API Error: " + plan, Data: map[string]any{"errorKind": "rate_limit"}}
		limit := ClassifyProviderLimit(request, now)
		if limit == nil || limit.ResetsAt != nil {
			t.Fatal("typed SDK plan limit without a reset must enter bounded unknown-reset recovery")
		}
	}
}

func TestProviderLimitGatewayResetRequiresTypedProviderSource(t *testing.T) {
	now := time.Date(2026, 8, 14, 5, 0, 0, 0, time.UTC)
	provider := "Internal error: API Error: You've hit your session limit · resets 1pm (UTC)"
	cases := []struct {
		name, message string
		data          map[string]any
	}{
		{"ordinary", provider, nil},
		{"authentication", provider, map[string]any{"errorKind": "authentication_failed"}},
		{"tool wrapper", "Internal error: MCP tool said resets 1pm (UTC)", map[string]any{"errorKind": "rate_limit"}},
		{"nested metadata", "Internal error", map[string]any{"errorKind": "rate_limit", "message": provider}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if ClassifyProviderLimit(&acpsdk.RequestError{Code: -32603, Message: tc.message, Data: tc.data}, now) != nil {
				t.Fatal("untrusted reset escaped its provider source")
			}
		})
	}
}

func TestProviderLimitRecordedWireThroughPromptCompletion(t *testing.T) {
	now := time.Now().UTC()
	cases := []struct {
		name, wire string
		limit      bool
	}{
		{"Claude session", `{"code":-32603,"message":"You've hit your session limit · resets 1pm (UTC)","data":{"errorKind":"rate_limit"}}`, true},
		{"Claude weekly", `{"code":-32603,"message":"You've hit your weekly limit · resets 1pm (UTC)","data":{"errorKind":"rate_limit"}}`, true},
		{"Codex plan", `{"code":-32603,"message":"Internal error","data":{"codexErrorInfo":"usageLimitExceeded","message":"You've hit your usage limit. sk-secret-canary"}}`, true},
		{"uncategorical nested limit", `{"code":-32603,"message":"Internal error","data":{"message":"You've hit your usage limit"}}`, false},
		{"ordinary", `{"code":-32603,"message":"Internal error","data":{"message":"MCP tool said usageLimitExceeded sk-secret-canary"}}`, false},
		{"auth precedence", `{"code":-32603,"message":"You've hit your session limit","data":{"errorKind":"rate_limit","codexErrorInfo":"unauthorized"}}`, false},
		{"auth", `{"code":-32603,"message":"Internal error","data":{"codexErrorInfo":"unauthorized","message":"You've hit your usage limit sk-secret-canary"}}`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var request acpsdk.RequestError
			if err := json.Unmarshal([]byte(tc.wire), &request); err != nil {
				t.Fatal(err)
			}
			host := newTestSessionHost(t)
			defer host.Stop()
			done := make(chan error, 1)
			host.config.OnPromptComplete = func(_ string, err error) { done <- err }
			host.finishPromptWithError(context.Background(), json.RawMessage(`"limit-turn"`), promptStartInfo{startedAt: now}, &request)
			select {
			case err := <-done:
				limit := ClassifyProviderLimit(err, now)
				if (limit != nil) != tc.limit {
					t.Fatalf("limit=%v, expected=%v", limit, tc.limit)
				}
				if limit != nil && err.Error() != "provider_limit_reached" {
					t.Fatalf("unsafe callback %q", err.Error())
				}
				if tc.name == "auth" && ClassifyPromptError(err) != "model_provider_credential_rejected" {
					t.Fatal("auth regression")
				}
			case <-time.After(time.Second):
				t.Fatal("completion did not run")
			}
			host.bufMu.RLock()
			defer host.bufMu.RUnlock()
			for _, msg := range host.messageBuf {
				if strings.Contains(string(msg.Data), "sk-secret-canary") {
					t.Fatal("diagnostic leaked provider text")
				}
			}
		})
	}
}
func TestProviderLimitResetAndRetryControls(t *testing.T) {
	now := time.Date(2026, 10, 12, 9, 30, 0, 0, time.UTC)
	err := &acpsdk.RequestError{Code: -32603, Message: "You've hit your session limit · resets 1pm (UTC)", Data: map[string]any{"errorKind": "rate_limit"}}
	limit := ClassifyProviderLimit(err, now)
	if limit == nil || limit.ResetsAt == nil || *limit.ResetsAt != time.Date(2026, 10, 12, 13, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("wrong reset: %+v", limit)
	}
	host := newTestSessionHost(t)
	defer host.Stop()
	if host.shouldRetryPromptError(context.Background(), err, 1, 4) {
		t.Fatal("limit blindly retried")
	}
	ordinary := errors.New("Provider HTTP 503 overloaded")
	if !host.shouldRetryPromptError(context.Background(), ordinary, 1, 4) {
		t.Fatal("ordinary overload did not retry")
	}
	if ClassifyProviderLimit(errors.New(`{"message":"You've hit your usage limit"}`), now) != nil {
		t.Fatal("untrusted JSON spoof")
	}
	api := acpsdk.NewInternalError(map[string]any{"errorKind": "rate_limit", "resetsAt": float64(now.Add(time.Hour).Unix())})
	if got := ClassifyProviderLimit(api, now); got == nil || got.ResetsAt == nil {
		t.Fatal("reset-bearing API 429 not classified")
	}
}

func TestCompletionContextRetainsAcceptedGeneration(t *testing.T) {
	host := newTestSessionHost(t)
	defer host.Stop()
	host.credentialAttribution.Store(credentialAttribution{CredentialReference: "credential-1", CredentialSource: "user", CredentialGeneration: 1})
	done := make(chan PromptCompletionContext, 1)
	host.config.OnPromptCompleteWithContext = func(_ string, _ error, completion PromptCompletionContext) { done <- completion }
	attempt, ok := host.beginPrompt(func() {}, nil)
	if !ok {
		t.Fatal("not accepted")
	}
	host.credentialAttribution.Store(credentialAttribution{CredentialReference: "credential-2", CredentialSource: "user", CredentialGeneration: 2})
	attempt.completeWith(host, "end_turn", nil, nil)
	select {
	case completion := <-done:
		if completion.CredentialGeneration != 1 || completion.PromptAttemptID != attempt.id || completion.StartedAt != attempt.startedAt.UnixMilli() {
			t.Fatalf("changed completion identity: %+v", completion)
		}
	case <-time.After(time.Second):
		t.Fatal("missing completion")
	}
}

func TestProviderLimitUsageWindowsRetainIndependentRejection(t *testing.T) {
	host := newTestSessionHost(t)
	defer host.Stop()
	host.credentialAttribution.Store(credentialAttribution{CredentialReference: "credential", CredentialSource: "user", CredentialGeneration: 1})
	now := host.now().UnixMilli()
	reset := now + 3600000
	host.usageReportMu.Lock()
	host.observeProviderLimitLocked(usageReportPayload{CredentialReference: "credential", CredentialGeneration: 1, ObservedAt: now - 2, RateLimits: []usageLimitPayload{{WindowType: "claude.weekly", Status: "rejected", ResetsAt: &reset}}})
	host.observeProviderLimitLocked(usageReportPayload{CredentialReference: "credential", CredentialGeneration: 1, ObservedAt: now - 1, RateLimits: []usageLimitPayload{{WindowType: "claude.session", Status: "allowed"}}})
	host.usageReportMu.Unlock()
	if got := host.promptProviderLimit(acpsdk.NewInternalError(map[string]any{"errorKind": "rate_limit"})); got == nil || got.ResetsAt == nil || *got.ResetsAt != reset {
		t.Fatalf("weekly rejection lost: %+v", got)
	}
	auth := acpsdk.NewInternalError(map[string]any{"codexErrorInfo": "unauthorized"})
	if host.promptProviderLimit(auth) != nil {
		t.Fatal("usage observation masked auth rejection")
	}
	host.usageReportMu.Lock()
	host.observeProviderLimitLocked(usageReportPayload{CredentialReference: "credential", CredentialGeneration: 1, ObservedAt: now, RateLimits: []usageLimitPayload{{WindowType: "claude.weekly", Status: "allowed"}}})
	host.observeProviderLimitLocked(usageReportPayload{CredentialReference: "credential", CredentialGeneration: 1, ObservedAt: now - 1, RateLimits: []usageLimitPayload{{WindowType: "claude.weekly", Status: "rejected", ResetsAt: &reset}}})
	host.usageReportMu.Unlock()
	if host.promptProviderLimit(acpsdk.NewInternalError(map[string]any{"errorKind": "rate_limit"})) != nil {
		t.Fatal("stale rejection replaced allowed window")
	}
}

func TestProviderLimitCodexProbePreservesSourceTimeAndAcceptedCredential(t *testing.T) {
	host := &SessionHost{config: SessionHostConfig{GatewayConfig: GatewayConfig{ProjectID: "project", NodeID: "node", SessionID: "session", ControlPlaneURL: "https://example.test", CallbackToken: "test-token"}}, usageReportRunning: true}
	attr := credentialAttribution{CredentialReference: "credential", CredentialSource: "user", CredentialGeneration: 2}
	host.credentialAttribution.Store(attr)
	now := host.now().UnixMilli()
	stale := time.UnixMilli(now - 5*60*1000).UTC().Format(time.RFC3339Nano)
	wire := []byte(`{"timestamp":"` + stale + `","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":100,"window_minutes":300,"resets_at":` + fmt.Sprint((now+3600000)/1000) + `}}}}`)
	limits, ok := parseCodexRolloutRateLimits(wire, now)
	if !ok {
		t.Fatal("missing rollout")
	}
	request, ok := host.buildUsageReportRequest(attr, true, "codex.rollout.rate_limits", now, limits)
	if !ok {
		t.Fatal("missing report")
	}
	host.enqueueUsageReport(request)
	if host.promptProviderLimit(acpsdk.NewInternalError(map[string]any{"errorKind": "rate_limit"})) != nil {
		t.Fatal("fresh probe refreshed stale source")
	}
	limits[0].ObservedAt = now
	request.payload.RateLimits = limits
	host.enqueueUsageReport(request)
	if host.promptProviderLimit(acpsdk.NewInternalError(map[string]any{"errorKind": "rate_limit"})) == nil {
		t.Fatal("fresh rejection missing")
	}
	if host.promptProviderLimit(errors.New("ordinary unrelated failure")) != nil {
		t.Fatal("cache masked ordinary failure")
	}
	if !host.shouldRetryPromptError(context.Background(), acpsdk.NewInternalError(map[string]any{"errorKind": "overloaded"}), 1, 3, credentialAttribution{CredentialReference: "old", CredentialGeneration: 1}) {
		t.Fatal("new credential cache suppressed old attempt retry")
	}
	if host.promptProviderLimit(acpsdk.NewInternalError(map[string]any{"errorKind": "rate_limit"}), credentialAttribution{CredentialReference: "old", CredentialGeneration: 1}) != nil {
		t.Fatal("new credential evidence relabeled to old attempt")
	}
}

func TestProviderLimitUsageCacheBoundsUnrecognizedWindows(t *testing.T) {
	host := &SessionHost{}
	host.credentialAttribution.Store(credentialAttribution{CredentialReference: "credential", CredentialSource: "user", CredentialGeneration: 1})
	now := host.now().UnixMilli()
	payload := usageReportPayload{CredentialReference: "credential", CredentialGeneration: 1, ObservedAt: now}
	for i := 0; i < 100; i++ {
		payload.RateLimits = append(payload.RateLimits, usageLimitPayload{WindowType: fmt.Sprint("window-", i), Status: "allowed"})
	}
	payload.RateLimits = append(payload.RateLimits, usageLimitPayload{WindowType: "excess", Status: "rejected"})
	host.observeProviderLimitLocked(payload)
	if host.promptProviderLimit(acpsdk.NewInternalError(map[string]any{"errorKind": "rate_limit"})) != nil {
		t.Fatal("excess window classified a failure")
	}
}
