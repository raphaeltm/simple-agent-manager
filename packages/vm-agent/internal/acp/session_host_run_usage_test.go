package acp

import (
	"context"
	"encoding/json"
	"os"
	"sync/atomic"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// The VM agent → control plane contract for token reports (rule 23). The API
// test apps/api/tests/unit/routes/agent-run-usage-callback.test.ts sends this
// exact file through the real route and schema.
const runUsageContractFixture = "../../../shared/tests/fixtures/vm-agent-usage-report-token-usage.json"

func runUsageTestHost(t *testing.T, script promptRetryScript, agentType string) (*SessionHost, *usageCallbackCapture) {
	t.Helper()
	host, _ := newPromptRetryTestHost(t, script)
	capture := wireUsageProbeControlPlane(t, host)
	host.storeCredentialAttribution(agentType, &agentCredential{
		credentialSource:     "user",
		credentialReference:  "cc_credentials:cred-1",
		credentialGeneration: 4,
		credentialProvider:   "anthropic",
		providerMode:         "direct",
	})
	return host, capture
}

func claudeQuotaResult(model string, input, output, cacheRead, cacheWrite int64) map[string]interface{} {
	count := map[string]interface{}{
		"totalTokens":           input + output + cacheRead + cacheWrite,
		"inputTokens":           input,
		"cachedInputTokens":     cacheRead,
		"cachedWriteTokens":     cacheWrite,
		"outputTokens":          output,
		"reasoningOutputTokens": 0,
	}
	return map[string]interface{}{
		"usage": map[string]interface{}{
			"inputTokens": input, "outputTokens": output, "cachedReadTokens": cacheRead,
			"cachedWriteTokens": cacheWrite, "totalTokens": input + output + cacheRead + cacheWrite,
		},
		"_meta": map[string]interface{}{
			"quota": map[string]interface{}{
				"token_count": count,
				"model_usage": []interface{}{map[string]interface{}{"model": model, "token_count": count}},
			},
		},
	}
}

func waitForTokenPayloads(t *testing.T, capture *usageCallbackCapture, want int) []usageReportPayload {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		capture.mu.Lock()
		var tokenReports []usageReportPayload
		for _, payload := range capture.payloads {
			if payload.TokenUsage != nil {
				tokenReports = append(tokenReports, payload)
			}
		}
		capture.mu.Unlock()
		if len(tokenReports) >= want {
			return tokenReports
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("expected %d token reports", want)
	return nil
}

// Real trigger (rule 62): two Claude Code turns complete through HandlePrompt;
// each report carries the running totals under one epoch, so the second
// report contains the first turn too.
func TestCompletedClaudePromptsReportCumulativeTokensPerModel(t *testing.T) {
	host, capture := runUsageTestHost(t, promptRetryScript{responses: []promptRetryResponse{
		{stopReason: "end_turn", result: claudeQuotaResult("claude-opus-5-5", 100, 20, 1000, 50)},
		{stopReason: "end_turn", result: claudeQuotaResult("claude-opus-5-5", 10, 5, 2000, 0)},
	}}, "claude-code")

	runPromptToCompletion(t, host)
	first := waitForTokenPayloads(t, capture, 1)[0]
	runPromptToCompletion(t, host)
	reports := waitForTokenPayloads(t, capture, 2)
	second := reports[1]

	if first.Source != sourceRunUsage || len(first.RateLimits) != 0 {
		t.Fatalf("first report source=%q limits=%d", first.Source, len(first.RateLimits))
	}
	if first.CredentialReference != "cc_credentials:cred-1" || first.CredentialGeneration != 4 {
		t.Fatalf("attribution = %q/%d", first.CredentialReference, first.CredentialGeneration)
	}
	if first.TokenUsage.Epoch == "" || first.TokenUsage.Epoch != second.TokenUsage.Epoch {
		t.Fatalf("epochs %q, %q must be equal and non-empty", first.TokenUsage.Epoch, second.TokenUsage.Epoch)
	}
	got := second.TokenUsage.Models
	if len(got) != 1 || got[0].Model != "claude-opus-5-5" || got[0].InputTokens != 110 ||
		got[0].OutputTokens != 25 || got[0].CacheReadTokens != 3000 || got[0].CacheWriteTokens != 50 {
		t.Fatalf("cumulative models = %+v", got)
	}
	if got[0].ReasoningTokens != nil {
		t.Fatalf("Claude reports reasoning inside output; got separate %d", *got[0].ReasoningTokens)
	}
}

// OpenCode's prompt usage has no model; it is attributed to the configured one.
func TestCompletedOpenCodePromptAttributesUsageToConfiguredModel(t *testing.T) {
	host, capture := runUsageTestHost(t, promptRetryScript{responses: []promptRetryResponse{{
		stopReason: "end_turn",
		result: map[string]interface{}{"usage": map[string]interface{}{
			"inputTokens": 40, "outputTokens": 9, "thoughtTokens": 3, "cachedReadTokens": 7, "totalTokens": 59,
		}},
	}}}, "opencode")
	host.storeRunUsageModel(&agentSettingsPayload{Model: "opencode-go/kimi-k2"})

	runPromptToCompletion(t, host)
	report := waitForTokenPayloads(t, capture, 1)[0]
	models := report.TokenUsage.Models
	if len(models) != 1 || models[0].Model != "opencode-go/kimi-k2" || models[0].InputTokens != 40 ||
		models[0].OutputTokens != 9 || models[0].CacheReadTokens != 7 ||
		models[0].ReasoningTokens == nil || *models[0].ReasoningTokens != 3 {
		t.Fatalf("models = %+v", models)
	}
}

// Codex's prompt usage is the last request only: it must not be counted. The
// rollout's cumulative thread total is reported instead, under the thread epoch.
func TestCompletedCodexPromptReportsRolloutTotalsNotPromptUsage(t *testing.T) {
	host, capture := runUsageTestHost(t, promptRetryScript{responses: []promptRetryResponse{{
		stopReason: "end_turn",
		result:     map[string]interface{}{"usage": map[string]interface{}{"inputTokens": 5, "outputTokens": 1, "totalTokens": 6}},
	}}}, "openai-codex")
	host.mu.Lock()
	host.setSessionIDLocked(testCodexThreadID)
	host.mu.Unlock()
	var reads atomic.Int32
	host.codexRolloutReader = func(context.Context, string) ([]byte, error) {
		reads.Add(1)
		return []byte(codexRolloutTokenFixture), nil
	}

	runPromptToCompletion(t, host)
	report := waitForTokenPayloads(t, capture, 1)[0]
	if report.TokenUsage.Epoch != "codex-"+testCodexThreadID {
		t.Fatalf("epoch = %q", report.TokenUsage.Epoch)
	}
	models := report.TokenUsage.Models
	if len(models) != 1 || models[0].Model != "gpt-5.5" || models[0].InputTokens != 6000 ||
		models[0].CacheReadTokens != 4000 || models[0].OutputTokens != 900 ||
		models[0].ReasoningTokens == nil || *models[0].ReasoningTokens != 300 {
		t.Fatalf("codex models = %+v", models)
	}
	if len(report.RateLimits) == 0 {
		t.Fatal("rollout limits must still be reported with the tokens")
	}
	time.Sleep(50 * time.Millisecond)
	for _, payload := range waitForTokenPayloads(t, capture, 1) {
		if payload.Source == sourceRunUsage {
			t.Fatal("codex prompt usage (last request only) must not be reported")
		}
	}
	if reads.Load() == 0 {
		t.Fatal("rollout was never read")
	}
}

const codexRolloutTokenFixture = `{"timestamp":"2026-11-16T10:00:00.000Z","type":"turn_context","payload":{"cwd":"/w","model":"gpt-5.4"}}
{"timestamp":"2026-11-16T10:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3000,"cached_input_tokens":1000,"output_tokens":400,"reasoning_output_tokens":100,"total_tokens":3400}},"rate_limits":null}}
{"timestamp":"2026-11-16T10:05:00.000Z","type":"turn_context","payload":{"cwd":"/w","model":"gpt-5.5"}}
{"timestamp":"2026-11-16T10:05:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10000,"cached_input_tokens":4000,"output_tokens":900,"reasoning_output_tokens":300,"total_tokens":10900}},"rate_limits":{"primary":{"used_percent":12.0,"window_minutes":300,"resets_at":1795000000}}}}
{"timestamp":"2026-11-16T10:05:02.000Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":null}}
`

func TestParseCodexRolloutTokenUsage(t *testing.T) {
	t.Parallel()
	usage := parseCodexRolloutTokenUsage([]byte(codexRolloutTokenFixture), testCodexThreadID)
	if usage == nil || len(usage.Models) != 1 || usage.Models[0].Model != "gpt-5.5" || usage.Models[0].InputTokens != 6000 {
		t.Fatalf("usage = %+v", usage)
	}
	if got := parseCodexRolloutTokenUsage([]byte(`{"type":"event_msg","payload":{"type":"agent_message"}}`), testCodexThreadID); got != nil {
		t.Fatalf("tail without totals must report nothing, got %+v", got)
	}
}

func TestPromptTurnTokenUsageReportsNothingWithoutTokens(t *testing.T) {
	t.Parallel()
	if got := promptTurnTokenUsage(promptResponseFromJSON(t, `{"stopReason":"end_turn"}`), "m"); got != nil {
		t.Fatalf("no usage → %+v", got)
	}
	if got := promptTurnTokenUsage(promptResponseFromJSON(t, `{"stopReason":"end_turn","usage":{"inputTokens":0,"outputTokens":0,"totalTokens":0}}`), "m"); got != nil {
		t.Fatalf("zero usage → %+v", got)
	}
}

// Builder without token data keeps the shape every control plane accepts; the
// token-only report keeps rateLimits an array, never null.
func TestBuildUsageReportRequestWithAndWithoutTokenUsage(t *testing.T) {
	t.Parallel()
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{
		ControlPlaneURL: "https://api.example.com", ProjectID: "project-1", NodeID: "node-1",
		SessionID: "session-1", CallbackToken: "callback-token",
	}})
	attr := credentialAttribution{AgentType: "claude-code", CredentialSource: "user", CredentialReference: "cc_credentials:cred-1", CredentialGeneration: 2}

	limitsOnly, ok := host.buildUsageReportRequest(attr, true, "claude-acp.usage_update", 1, []usageLimitPayload{{WindowType: "claude.five_hour"}})
	if !ok {
		t.Fatal("limits report not built")
	}
	encoded, _ := json.Marshal(limitsOnly.payload)
	var asMap map[string]any
	_ = json.Unmarshal(encoded, &asMap)
	if _, present := asMap["tokenUsage"]; present {
		t.Fatalf("limits-only report must omit tokenUsage: %s", encoded)
	}

	tokensOnly, ok := host.buildUsageReportRequest(attr, true, sourceRunUsage, 1_794_847_000_000, nil)
	if !ok {
		t.Fatal("token-only report not built")
	}
	reasoning := int64(12)
	tokensOnly.payload.TokenUsage = &tokenUsagePayload{Epoch: "host-0123456789abcdef01234567", Models: []tokenModelPayload{
		{Model: "claude-opus-5-5", InputTokens: 1200, OutputTokens: 340, CacheReadTokens: 56000, CacheWriteTokens: 7800},
		{Model: "", InputTokens: 10, OutputTokens: 2, ReasoningTokens: &reasoning},
	}}
	encoded, err := json.MarshalIndent(tokensOnly.payload, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := os.ReadFile(runUsageContractFixture)
	if err != nil {
		t.Fatalf("read contract fixture: %v", err)
	}
	if string(encoded)+"\n" != string(fixture) {
		t.Fatalf("payload no longer matches the API contract fixture %s:\n%s", runUsageContractFixture, encoded)
	}
	if tokensOnly.url != "https://api.example.com/api/projects/project-1/acp-sessions/session-1/usage" {
		t.Fatalf("url = %s", tokensOnly.url)
	}
}

// Within one epoch the newer cumulative report supersedes the older pending
// one; reports of different epochs are never merged.
func TestTokenUsageCoalesceKeySeparatesEpochs(t *testing.T) {
	t.Parallel()
	base := usageReportRequest{url: "u", payload: usageReportPayload{Source: sourceRunUsage}}
	a := base
	a.payload.TokenUsage = &tokenUsagePayload{Epoch: "e1"}
	b := base
	b.payload.TokenUsage = &tokenUsagePayload{Epoch: "e1", Models: []tokenModelPayload{{InputTokens: 9}}}
	c := base
	c.payload.TokenUsage = &tokenUsagePayload{Epoch: "e2"}
	if usageReportCoalesceKey(a) != usageReportCoalesceKey(b) {
		t.Fatal("same epoch must coalesce")
	}
	if usageReportCoalesceKey(a) == usageReportCoalesceKey(c) {
		t.Fatal("different epochs must not coalesce")
	}
}

func promptResponseFromJSON(t *testing.T, raw string) acpsdk.PromptResponse {
	t.Helper()
	var resp acpsdk.PromptResponse
	if err := json.Unmarshal([]byte(raw), &resp); err != nil {
		t.Fatalf("decode prompt response: %v", err)
	}
	return resp
}
