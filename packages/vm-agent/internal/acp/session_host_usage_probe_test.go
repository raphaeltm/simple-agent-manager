package acp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const testCodexThreadID = "5973b6c0-94b8-487b-a530-2aeb6098ae0e"

// codexRolloutFixture mimics the tail of a Codex 0.160.0 rollout: a truncated
// first line (the tail cut), a token_count without rate limits, a stale
// snapshot, then the newest snapshot that must win.
const codexRolloutFixture = `_count","info":{"total_token_usage":{"input_tokens":1}},"rate_limits":null}}
{"timestamp":"2026-10-05T10:00:00.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[]}}
{"timestamp":"2026-10-05T10:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10}},"rate_limits":null}}
{"timestamp":"2026-10-05T10:00:02.000Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"limit_id":"codex","primary":{"used_percent":5.0,"window_minutes":300,"resets_at":1759660000},"secondary":{"used_percent":1.0,"window_minutes":10080,"resets_at":1760000000},"credits":{"has_credits":false,"unlimited":false,"balance":null},"plan_type":"pro"}}}
{"timestamp":"2026-10-05T10:05:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2000}},"rate_limits":{"limit_id":"codex","primary":{"used_percent":41.5,"window_minutes":300,"resets_at":1759662000},"secondary":{"used_percent":12.0,"window_minutes":10080,"resets_at":1760000000},"credits":{"has_credits":false,"unlimited":false,"balance":null},"plan_type":"pro"}}}
{"timestamp":"2026-10-05T10:05:01.000Z","type":"event_msg","payload":{"type":"agent_message","message":"done"}}
`

func TestParseCodexRolloutRateLimitsPicksNewestSnapshot(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 5, 10, 6, 0, 0, time.UTC).UnixMilli()

	limits, ok := parseCodexRolloutRateLimits([]byte(codexRolloutFixture), now)
	if !ok {
		t.Fatal("expected a rate-limit snapshot")
	}
	if len(limits) != 2 {
		t.Fatalf("limits = %d, want 2", len(limits))
	}
	primary, secondary := limits[0], limits[1]
	if primary.WindowType != "codex.primary" || secondary.WindowType != "codex.secondary" {
		t.Fatalf("window types = %q, %q", primary.WindowType, secondary.WindowType)
	}
	if primary.Provider != "openai" || primary.Source != "vm-agent.codex_rollout" {
		t.Fatalf("provider/source = %q/%q", primary.Provider, primary.Source)
	}
	if primary.UtilizationPercent == nil || *primary.UtilizationPercent != 41.5 {
		t.Fatalf("primary utilization = %v, want 41.5 (newest snapshot)", primary.UtilizationPercent)
	}
	if primary.WindowMinutes == nil || *primary.WindowMinutes != 300 {
		t.Fatalf("primary windowMinutes = %v, want 300", primary.WindowMinutes)
	}
	if primary.ResetsAt == nil || *primary.ResetsAt != 1759662000*1000 {
		t.Fatalf("primary resetsAt = %v, want unix seconds converted to ms", primary.ResetsAt)
	}
	if primary.Status != "allowed" {
		t.Fatalf("primary status = %q, want allowed", primary.Status)
	}
	wantObserved := time.Date(2026, 10, 5, 10, 5, 0, 0, time.UTC).UnixMilli()
	if primary.ObservedAt != wantObserved {
		t.Fatalf("observedAt = %d, want rollout line timestamp %d", primary.ObservedAt, wantObserved)
	}
	if primary.FreshnessMs == nil || *primary.FreshnessMs != now-wantObserved {
		t.Fatalf("freshnessMs = %v, want %d", primary.FreshnessMs, now-wantObserved)
	}
	if secondary.WindowMinutes == nil || *secondary.WindowMinutes != 10080 {
		t.Fatalf("secondary windowMinutes = %v, want 10080", secondary.WindowMinutes)
	}
}

func TestParseCodexRolloutRateLimitsWeeklyOnlyPlanAndExhaustion(t *testing.T) {
	t.Parallel()
	// Prolite-style plan: the weekly window is the primary (and only) window.
	tail := `{"timestamp":"2026-10-05T10:05:00Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":100.0,"window_minutes":10080,"resets_at":1760000000},"secondary":null,"plan_type":"prolite"}}}` + "\n"
	limits, ok := parseCodexRolloutRateLimits([]byte(tail), time.Now().UnixMilli())
	if !ok || len(limits) != 1 {
		t.Fatalf("limits = %v ok=%v, want one primary window", limits, ok)
	}
	if limits[0].WindowType != "codex.primary" || *limits[0].WindowMinutes != 10080 {
		t.Fatalf("window = %+v, want primary with weekly length", limits[0])
	}
	if limits[0].Status != "rejected" {
		t.Fatalf("status = %q, want rejected at 100%%", limits[0].Status)
	}
}

func TestParseCodexRolloutRateLimitsWithoutSnapshot(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"empty":          "",
		"no rate limits": `{"timestamp":"2026-10-05T10:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{},"rate_limits":null}}` + "\n",
		"empty snapshot": `{"timestamp":"2026-10-05T10:00:01Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":null,"secondary":null}}}` + "\n",
		"other event":    `{"timestamp":"2026-10-05T10:00:01Z","type":"event_msg","payload":{"type":"agent_message","message":"x"}}` + "\n",
		"garbage":        "not json\n{also not json",
		"response items": `{"timestamp":"t","type":"response_item","payload":{"type":"message"}}` + "\n",
	}
	for name, tail := range cases {
		if limits, ok := parseCodexRolloutRateLimits([]byte(tail), 0); ok || limits != nil {
			t.Fatalf("%s: expected no snapshot, got %v", name, limits)
		}
	}
}

func TestParseOpenCodeGoUsageMapsDocumentedWindows(t *testing.T) {
	t.Parallel()
	body := `{"usage":{"rolling":{"status":"ok","percent":1,"resetsAt":"2026-09-13T10:42:47.510Z"},"weekly":{"status":"warning","percent":84.5,"resetsAt":"2026-09-14T00:00:00.510Z"},"monthly":{"status":"exceeded","percent":100,"resetsAt":"2026-10-11T01:55:50.510Z"},"bonus":{"status":"ok","percent":3}}}`
	now := time.Date(2026, 9, 13, 9, 0, 0, 0, time.UTC).UnixMilli()

	limits, ok := parseOpenCodeGoUsage([]byte(body), now)
	if !ok || len(limits) != 3 {
		t.Fatalf("limits = %d ok=%v, want the three documented windows only", len(limits), ok)
	}
	byType := map[string]usageLimitPayload{}
	for _, limit := range limits {
		byType[limit.WindowType] = limit
	}
	rolling := byType["opencode.rolling"]
	if rolling.Provider != "opencode" || rolling.Source != "vm-agent.opencode_go_usage" {
		t.Fatalf("provider/source = %q/%q", rolling.Provider, rolling.Source)
	}
	if rolling.Status != "allowed" || *rolling.UtilizationPercent != 1 {
		t.Fatalf("rolling = %+v", rolling)
	}
	wantReset := time.Date(2026, 9, 13, 10, 42, 47, 510_000_000, time.UTC).UnixMilli()
	if rolling.ResetsAt == nil || *rolling.ResetsAt != wantReset {
		t.Fatalf("rolling resetsAt = %v, want %d", rolling.ResetsAt, wantReset)
	}
	if byType["opencode.weekly"].Status != "allowed_warning" {
		t.Fatalf("weekly status = %q, want allowed_warning", byType["opencode.weekly"].Status)
	}
	if byType["opencode.monthly"].Status != "rejected" {
		t.Fatalf("monthly status = %q, want rejected", byType["opencode.monthly"].Status)
	}
	if _, present := byType["opencode.bonus"]; present {
		t.Fatal("undocumented window must be ignored, not guessed at")
	}
	if rolling.ObservedAt != now {
		t.Fatalf("observedAt = %d, want probe time %d", rolling.ObservedAt, now)
	}
}

func TestParseOpenCodeGoUsageRejectsUnexpectedShapes(t *testing.T) {
	t.Parallel()
	for name, body := range map[string]string{
		"html":          "<html>login</html>",
		"empty object":  "{}",
		"empty usage":   `{"usage":{}}`,
		"wrong windows": `{"usage":{"daily":{"status":"ok","percent":1}}}`,
		"no signal":     `{"usage":{"rolling":{"status":"mystery"}}}`,
	} {
		if limits, ok := parseOpenCodeGoUsage([]byte(body), 0); ok || len(limits) != 0 {
			t.Fatalf("%s: expected no windows, got %v", name, limits)
		}
	}
}

// usageCallbackCapture is a fake control plane that records usage callbacks.
type usageCallbackCapture struct {
	mu       sync.Mutex
	payloads []usageReportPayload
}

func (c *usageCallbackCapture) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/usage") {
			// Activity and other lifecycle callbacks also target the control plane;
			// acknowledge them so only usage reports are captured.
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var payload usageReportPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode usage payload: %v", err)
		}
		c.mu.Lock()
		c.payloads = append(c.payloads, payload)
		c.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}
}

func (c *usageCallbackCapture) waitForPayload(t *testing.T, timeout time.Duration) usageReportPayload {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		if len(c.payloads) > 0 {
			payload := c.payloads[0]
			c.mu.Unlock()
			return payload
		}
		c.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("usage callback was not posted")
	return usageReportPayload{}
}

func (c *usageCallbackCapture) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.payloads)
}

// wireUsageProbeControlPlane points a prompt-retry test host at a fake control
// plane and gives it the identity the usage callback needs.
func wireUsageProbeControlPlane(t *testing.T, host *SessionHost) *usageCallbackCapture {
	t.Helper()
	capture := &usageCallbackCapture{}
	server := httptest.NewServer(capture.handler(t))
	t.Cleanup(server.Close)
	host.config.ControlPlaneURL = server.URL
	host.config.ProjectID = "project-1"
	host.config.NodeID = "node-1"
	host.config.CallbackToken = "callback-token"
	host.config.HTTPClient = server.Client()
	host.config.TerminalActivityReportAttempts = 1
	host.config.TerminalActivityReportBackoff = time.Millisecond
	host.config.ActivityReportTimeout = time.Second
	host.config.UsageProbeTimeout = 2 * time.Second
	return capture
}

func runPromptToCompletion(t *testing.T, host *SessionHost) {
	t.Helper()
	var completed sync.WaitGroup
	completed.Add(1)
	host.config.OnPromptComplete = func(stopReason string, promptErr error) {
		defer completed.Done()
		if stopReason != "end_turn" || promptErr != nil {
			t.Errorf("prompt completion = %q/%v, want end_turn/nil", stopReason, promptErr)
		}
	}
	host.HandlePrompt(context.Background(), json.RawMessage(`1`), promptRetryParams(), "viewer-1", false)
	completed.Wait()
}

// TestCompletedCodexPromptReportsRolloutRateLimits enters through the real
// trigger (rule 62): a prompt completes against a fake Codex agent, and the
// host must read the rollout for the live thread and post both windows.
func TestCompletedCodexPromptReportsRolloutRateLimits(t *testing.T) {
	host, _ := newPromptRetryTestHost(t, promptRetryScript{
		responses: []promptRetryResponse{{stopReason: "end_turn"}},
	})
	capture := wireUsageProbeControlPlane(t, host)
	host.storeCredentialAttribution("openai-codex", &agentCredential{
		credentialSource:     "user",
		credentialReference:  "cc_credentials:codex-1",
		credentialGeneration: 3,
		credentialProvider:   "openai",
		providerMode:         "direct",
	})
	host.mu.Lock()
	host.setSessionIDLocked(testCodexThreadID)
	host.mu.Unlock()

	var readThread atomic.Value
	host.codexRolloutReader = func(_ context.Context, threadID string) ([]byte, error) {
		readThread.Store(threadID)
		return []byte(codexRolloutFixture), nil
	}

	runPromptToCompletion(t, host)
	payload := capture.waitForPayload(t, 5*time.Second)

	if got, _ := readThread.Load().(string); got != testCodexThreadID {
		t.Fatalf("rollout read for thread %q, want the live ACP session id %q", got, testCodexThreadID)
	}
	if payload.Source != "vm-agent.codex_rollout" || payload.AgentType != "openai-codex" {
		t.Fatalf("payload source/agent = %q/%q", payload.Source, payload.AgentType)
	}
	if payload.CredentialReference != "cc_credentials:codex-1" || payload.CredentialGeneration != 3 {
		t.Fatalf("attribution = %q gen %d", payload.CredentialReference, payload.CredentialGeneration)
	}
	if len(payload.RateLimits) != 2 || payload.RateLimits[0].WindowType != "codex.primary" {
		t.Fatalf("rateLimits = %+v", payload.RateLimits)
	}
	if *payload.RateLimits[0].UtilizationPercent != 41.5 {
		t.Fatalf("primary utilization = %v, want newest rollout snapshot", *payload.RateLimits[0].UtilizationPercent)
	}
}

// TestCompletedOpenCodeGoPromptReportsUsageWindows: the OpenCode Go key retained
// at startup is presented to the usage endpoint after the turn, and the three
// documented windows reach the control plane.
func TestCompletedOpenCodeGoPromptReportsUsageWindows(t *testing.T) {
	host, _ := newPromptRetryTestHost(t, promptRetryScript{
		responses: []promptRetryResponse{{stopReason: "end_turn"}},
	})
	capture := wireUsageProbeControlPlane(t, host)

	var authHeader atomic.Value
	usage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader.Store(r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"usage":{"rolling":{"status":"ok","percent":7,"resetsAt":"2026-10-05T15:00:00Z"},"weekly":{"status":"ok","percent":39,"resetsAt":"2026-10-06T00:00:00Z"},"monthly":{"status":"ok","percent":19,"resetsAt":"2026-11-01T00:00:00Z"}}}`))
	}))
	t.Cleanup(usage.Close)
	host.config.OpenCodeGoUsageURL = usage.URL
	// One client reaches both fake servers (plain HTTP).
	host.config.HTTPClient = &http.Client{Timeout: 2 * time.Second}

	host.storeCredentialAttribution("opencode", &agentCredential{
		credentialSource:     "project",
		credentialReference:  "cc_credentials:go-1",
		credentialGeneration: 1,
		credentialProvider:   "agent",
		providerMode:         "direct",
	})
	host.storeOpencodeUsageProbeKey("opencode",
		&agentCredential{credential: "oc-go-key", credentialKind: "api-key"},
		&agentSettingsPayload{OpencodeProvider: "opencode-go"})

	runPromptToCompletion(t, host)
	payload := capture.waitForPayload(t, 5*time.Second)

	if got, _ := authHeader.Load().(string); got != "Bearer oc-go-key" {
		t.Fatalf("usage endpoint Authorization = %q, want the session's OpenCode key", got)
	}
	if payload.Source != "vm-agent.opencode_go_usage" || payload.CredentialSource != "project" {
		t.Fatalf("payload source/credentialSource = %q/%q", payload.Source, payload.CredentialSource)
	}
	types := []string{}
	for _, limit := range payload.RateLimits {
		types = append(types, limit.WindowType)
		if limit.Provider != "opencode" {
			t.Fatalf("provider = %q, want opencode (server-side default would be the consumer kind)", limit.Provider)
		}
	}
	if strings.Join(types, ",") != "opencode.rolling,opencode.weekly,opencode.monthly" {
		t.Fatalf("window types = %v", types)
	}
}

// Claude sessions already report through the ACP stream; a completed Claude
// prompt must not start a probe. Liveness: the prompt itself completes.
func TestCompletedClaudePromptDoesNotProbe(t *testing.T) {
	host, _ := newPromptRetryTestHost(t, promptRetryScript{
		responses: []promptRetryResponse{{stopReason: "end_turn"}},
	})
	capture := wireUsageProbeControlPlane(t, host)
	host.storeCredentialAttribution("claude-code", &agentCredential{
		credentialSource: "user", credentialReference: "cc_credentials:claude-1", credentialProvider: "anthropic", providerMode: "direct",
	})
	var reads atomic.Int32
	host.codexRolloutReader = func(context.Context, string) ([]byte, error) {
		reads.Add(1)
		return []byte(codexRolloutFixture), nil
	}

	runPromptToCompletion(t, host)
	time.Sleep(50 * time.Millisecond)

	if reads.Load() != 0 || capture.count() != 0 {
		t.Fatalf("claude completion probed: reads=%d posts=%d", reads.Load(), capture.count())
	}
}

func TestOpencodeUsageProbeKeyLifecycle(t *testing.T) {
	t.Parallel()
	host := newTestSessionHost(t)
	cred := &agentCredential{credential: "oc-key", credentialKind: "api-key"}

	host.storeOpencodeUsageProbeKey("opencode", cred, &agentSettingsPayload{OpencodeProvider: "opencode-zen"})
	if host.loadOpencodeUsageProbeKey() != "" {
		t.Fatal("Zen has no usage API; no key must be retained")
	}
	host.storeOpencodeUsageProbeKey("opencode", cred, &agentSettingsPayload{OpencodeProvider: "custom"})
	if host.loadOpencodeUsageProbeKey() != "" {
		t.Fatal("custom OpenAI-compatible providers must not be probed")
	}
	host.storeOpencodeUsageProbeKey("opencode", cred, nil)
	if host.loadOpencodeUsageProbeKey() != "" {
		t.Fatal("missing settings default to Zen and must not retain a key")
	}
	host.storeOpencodeUsageProbeKey("opencode",
		&agentCredential{credential: "proxied", credentialKind: "api-key", inferenceConfig: &inferenceConfig{}},
		&agentSettingsPayload{OpencodeProvider: "opencode-go"})
	if host.loadOpencodeUsageProbeKey() != "" {
		t.Fatal("proxy-routed credentials are not OpenCode Go keys")
	}
	host.storeOpencodeUsageProbeKey("opencode", cred, &agentSettingsPayload{OpencodeProvider: "opencode-go"})
	if host.loadOpencodeUsageProbeKey() != "oc-key" {
		t.Fatal("opencode-go api-key credential must be retained for probes")
	}
	// Switching agents must not carry the previous key forward.
	host.storeOpencodeUsageProbeKey("claude-code", cred, &agentSettingsPayload{OpencodeProvider: "opencode-go"})
	if host.loadOpencodeUsageProbeKey() != "" {
		t.Fatal("a non-OpenCode agent must clear the retained key")
	}
	host.storeOpencodeUsageProbeKey("opencode", cred, &agentSettingsPayload{OpencodeProvider: "opencode-go"})
	host.mu.Lock()
	host.stopCurrentAgentLocked()
	host.mu.Unlock()
	if host.loadOpencodeUsageProbeKey() != "" {
		t.Fatal("stopping the agent must clear the retained key")
	}
}

func TestScheduleProviderUsageProbeGuards(t *testing.T) {
	t.Parallel()
	host := newTestSessionHost(t)
	if host.scheduleProviderUsageProbe() {
		t.Fatal("no attribution: nothing to probe")
	}
	host.storeCredentialAttribution("openai-codex", &agentCredential{credentialSource: "user", credentialReference: "cc_credentials:x"})
	if host.scheduleProviderUsageProbe() {
		t.Fatal("codex without a live thread id must not probe")
	}
	host.storeCredentialAttribution("opencode", &agentCredential{credentialSource: "user", credentialReference: "cc_credentials:x"})
	if host.scheduleProviderUsageProbe() {
		t.Fatal("opencode without a retained Go key must not probe")
	}
}

func TestProbeCodexRolloutRejectsNonUUIDThreadIDs(t *testing.T) {
	t.Parallel()
	host := newTestSessionHost(t)
	var reads atomic.Int32
	host.codexRolloutReader = func(context.Context, string) ([]byte, error) {
		reads.Add(1)
		return []byte(codexRolloutFixture), nil
	}
	for _, id := range []string{"", "acp-session-retry", "$(rm -rf /)", "5973b6c0-94b8-487b-a530-2aeb6098ae0e*"} {
		if limits, ok := host.probeCodexRolloutRateLimits(context.Background(), id); ok || limits != nil {
			t.Fatalf("%q: expected rejection, got %v", id, limits)
		}
	}
	if reads.Load() != 0 {
		t.Fatalf("reader invoked %d times for invalid ids", reads.Load())
	}
	if _, ok := host.probeCodexRolloutRateLimits(context.Background(), testCodexThreadID); !ok {
		t.Fatal("valid UUID must be read")
	}
}

func TestParseCodexRolloutRateLimitsRejectsReachedWindowsBelowFullUtilization(t *testing.T) {
	t.Parallel()
	now := time.Now().UnixMilli()
	primaryReached := `{"timestamp":"2026-10-05T10:05:00Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":60.0,"window_minutes":300,"resets_at":1759662000},"secondary":{"used_percent":12.0,"window_minutes":10080,"resets_at":1760000000},"rate_limit_reached_type":"primary"}}}` + "\n"
	limits, ok := parseCodexRolloutRateLimits([]byte(primaryReached), now)
	if !ok || len(limits) != 2 {
		t.Fatalf("limits = %v ok=%v", limits, ok)
	}
	if limits[0].Status != "rejected" || limits[1].Status != "allowed" {
		t.Fatalf("rate_limit_reached_type=primary should reject only the primary window: %q/%q", limits[0].Status, limits[1].Status)
	}

	spendCap := `{"timestamp":"2026-10-05T10:05:00Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":30.0,"window_minutes":300},"secondary":{"used_percent":5.0,"window_minutes":10080},"spend_control_reached":true}}}` + "\n"
	limits, ok = parseCodexRolloutRateLimits([]byte(spendCap), now)
	if !ok || limits[0].Status != "rejected" || limits[1].Status != "rejected" {
		t.Fatalf("spend_control_reached must reject every window: %+v", limits)
	}

	unknownShape := `{"timestamp":"2026-10-05T10:05:00Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":30.0,"window_minutes":300},"secondary":{"used_percent":5.0,"window_minutes":10080},"rate_limit_reached_type":{"kind":"credits"}}}}` + "\n"
	limits, ok = parseCodexRolloutRateLimits([]byte(unknownShape), now)
	if !ok || limits[0].Status != "rejected" || limits[1].Status != "rejected" {
		t.Fatalf("an unrecognised reached type must fail closed to rejected: %+v", limits)
	}

	nullReached := `{"timestamp":"2026-10-05T10:05:00Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":30.0,"window_minutes":300},"secondary":null,"rate_limit_reached_type":null,"spend_control_reached":false}}}` + "\n"
	limits, ok = parseCodexRolloutRateLimits([]byte(nullReached), now)
	if !ok || len(limits) != 1 || limits[0].Status != "allowed" {
		t.Fatalf("null/false reached markers must not reject: %+v", limits)
	}
}

func writeRollout(t *testing.T, dir, name, content string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// The standalone reader is the real cf-container path; it must honour
// CODEX_HOME, pick the newest rollout for the thread at any depth, and read only
// the bounded tail of a large file.
func TestReadLocalCodexRolloutTailPicksNewestAndBoundsTheRead(t *testing.T) {
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	sessions := filepath.Join(codexHome, "sessions")

	stale := `{"timestamp":"2026-10-04T09:00:00Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":1.0,"window_minutes":300}}}}` + "\n"
	writeRollout(t, filepath.Join(sessions, "2026", "10", "04"), "rollout-2026-10-04T09-00-00-"+testCodexThreadID+".jsonl", stale)
	// Another thread's rollout in the newest directory must not be picked.
	writeRollout(t, filepath.Join(sessions, "2026", "10", "05"), "rollout-2026-10-05T11-00-00-11111111-2222-4333-8444-555555555555.jsonl", stale)

	// The live rollout is larger than the tail bound; the newest snapshot sits at the end.
	filler := strings.Repeat(`{"timestamp":"2026-10-05T10:00:00Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"`+strings.Repeat("x", 900)+`"}]}}`+"\n", 400)
	newest := `{"timestamp":"2026-10-05T10:05:00Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":77.0,"window_minutes":300,"resets_at":1759662000}}}}` + "\n"
	// A revert-style name (`_<rollout_id>` suffix) at a deeper, non-date path still matches.
	live := writeRollout(t, filepath.Join(sessions, "2026", "10", "05", "extra"), "rollout-2026-10-05T10-00-00-"+testCodexThreadID+"_7.jsonl", filler+newest)
	if info, err := os.Stat(live); err != nil || info.Size() <= codexRolloutTailBytes {
		t.Fatalf("fixture must exceed the tail bound: size=%d err=%v", info.Size(), err)
	}

	tail, err := readLocalCodexRolloutTail(testCodexThreadID)
	if err != nil {
		t.Fatalf("readLocalCodexRolloutTail: %v", err)
	}
	if len(tail) != codexRolloutTailBytes {
		t.Fatalf("tail length = %d, want exactly the bound %d", len(tail), codexRolloutTailBytes)
	}
	limits, ok := parseCodexRolloutRateLimits(tail, time.Now().UnixMilli())
	if !ok || len(limits) != 1 || *limits[0].UtilizationPercent != 77 {
		t.Fatalf("expected the newest snapshot from the live rollout, got %+v ok=%v", limits, ok)
	}

	// Through the host: with no container resolver the default reader is the local one.
	host := newTestSessionHost(t)
	host.config.ContainerResolver = nil
	got, ok := host.probeCodexRolloutRateLimits(context.Background(), testCodexThreadID)
	if !ok || len(got) != 1 || *got[0].UtilizationPercent != 77 {
		t.Fatalf("default reader did not use the local rollout: %+v ok=%v", got, ok)
	}
}

func TestReadLocalCodexRolloutTailWithoutRollouts(t *testing.T) {
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	if tail, err := readLocalCodexRolloutTail(testCodexThreadID); err != nil || tail != nil {
		t.Fatalf("missing sessions dir: tail=%v err=%v, want nil/nil", tail, err)
	}
	if err := os.MkdirAll(filepath.Join(codexHome, "sessions", "2026", "10", "05"), 0o755); err != nil {
		t.Fatal(err)
	}
	if tail, err := readLocalCodexRolloutTail(testCodexThreadID); err != nil || tail != nil {
		t.Fatalf("empty sessions dir: tail=%v err=%v, want nil/nil", tail, err)
	}
}

func TestCompletedOpenCodeGoPromptSkipsReportOnNon200(t *testing.T) {
	host, _ := newPromptRetryTestHost(t, promptRetryScript{
		responses: []promptRetryResponse{{stopReason: "end_turn"}},
	})
	capture := wireUsageProbeControlPlane(t, host)
	var hits atomic.Int32
	usage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	t.Cleanup(usage.Close)
	host.config.OpenCodeGoUsageURL = usage.URL
	host.config.HTTPClient = &http.Client{Timeout: 2 * time.Second}
	host.storeCredentialAttribution("opencode", &agentCredential{
		credentialSource: "user", credentialReference: "cc_credentials:go-1", credentialProvider: "agent", providerMode: "direct",
	})
	host.storeOpencodeUsageProbeKey("opencode",
		&agentCredential{credential: "oc-go-key", credentialKind: "api-key"},
		&agentSettingsPayload{OpencodeProvider: "opencode-go"})

	runPromptToCompletion(t, host)
	deadline := time.Now().Add(2 * time.Second)
	for hits.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if hits.Load() == 0 {
		t.Fatal("usage endpoint was never called (liveness)")
	}
	time.Sleep(50 * time.Millisecond)
	if capture.count() != 0 {
		t.Fatalf("a non-200 usage response must not produce a report, got %d", capture.count())
	}
}

func TestCompletedOpenCodeGoPromptNeverFollowsARedirectWithTheBearerToken(t *testing.T) {
	host, _ := newPromptRetryTestHost(t, promptRetryScript{
		responses: []promptRetryResponse{{stopReason: "end_turn"}},
	})
	capture := wireUsageProbeControlPlane(t, host)
	// An attacker-controlled (or merely misconfigured) destination: it must never
	// see the request, let alone the Authorization header.
	var leakedAuth atomic.Int32
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			leakedAuth.Add(1)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"usage":{"rolling":{"status":"ok","percent":1,"resetsAt":"2026-10-05T21:19:20.000Z"}}}`))
	}))
	t.Cleanup(elsewhere.Close)
	var hits atomic.Int32
	usage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.Redirect(w, r, elsewhere.URL+"/usage", http.StatusFound)
	}))
	t.Cleanup(usage.Close)
	host.config.OpenCodeGoUsageURL = usage.URL
	host.config.HTTPClient = &http.Client{Timeout: 2 * time.Second}
	host.storeCredentialAttribution("opencode", &agentCredential{
		credentialSource: "user", credentialReference: "cc_credentials:go-1", credentialProvider: "agent", providerMode: "direct",
	})
	host.storeOpencodeUsageProbeKey("opencode",
		&agentCredential{credential: "oc-go-key", credentialKind: "api-key"},
		&agentSettingsPayload{OpencodeProvider: "opencode-go"})

	runPromptToCompletion(t, host)
	deadline := time.Now().Add(2 * time.Second)
	for hits.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if hits.Load() == 0 {
		t.Fatal("usage endpoint was never called (liveness)")
	}
	time.Sleep(50 * time.Millisecond)
	if leakedAuth.Load() != 0 {
		t.Fatalf("the bearer token was forwarded to the redirect target %d time(s)", leakedAuth.Load())
	}
	if capture.count() != 0 {
		t.Fatalf("a redirected usage response must not produce a report, got %d", capture.count())
	}
}

func TestProbeOpenCodeGoUsageHonoursTheProbeTimeout(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	usage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-release:
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(func() { close(release); usage.Close() })
	host := newTestSessionHost(t)
	host.config.OpenCodeGoUsageURL = usage.URL
	host.config.UsageProbeTimeout = 30 * time.Millisecond
	host.config.HTTPClient = &http.Client{}

	ctx, cancel := context.WithTimeout(context.Background(), host.usageProbeTimeout())
	defer cancel()
	started := time.Now()
	limits, ok := host.probeOpenCodeGoUsage(ctx, "oc-go-key")
	if ok || limits != nil {
		t.Fatalf("slow endpoint must yield no observation, got %+v", limits)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("probe did not respect the timeout: took %s", elapsed)
	}
}

func TestScheduleProviderUsageProbeIsSingleFlight(t *testing.T) {
	host := newTestSessionHost(t)
	host.storeCredentialAttribution("openai-codex", &agentCredential{credentialSource: "user", credentialReference: "cc_credentials:x", credentialProvider: "openai", providerMode: "direct"})
	host.mu.Lock()
	host.setSessionIDLocked(testCodexThreadID)
	host.mu.Unlock()
	host.config.UsageProbeTimeout = 5 * time.Second

	release := make(chan struct{})
	var reads atomic.Int32
	host.codexRolloutReader = func(ctx context.Context, _ string) ([]byte, error) {
		reads.Add(1)
		select {
		case <-release:
		case <-ctx.Done():
		}
		return nil, context.Canceled
	}

	if !host.scheduleProviderUsageProbe() {
		t.Fatal("first probe must start")
	}
	deadline := time.Now().Add(time.Second)
	for reads.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if host.scheduleProviderUsageProbe() {
		t.Fatal("second probe must be rejected while the first is in flight")
	}
	close(release)
	deadline = time.Now().Add(time.Second)
	for host.usageProbeInFlight.Load() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !host.scheduleProviderUsageProbe() {
		t.Fatal("probe must be schedulable again once the previous one finished")
	}
}

// Rule 71: the probe must outlive the prompt's own context. Cancelling the
// caller's context at completion must not cancel the rollout read or the report.
func TestProbeSurvivesCallerContextCancellation(t *testing.T) {
	host, _ := newPromptRetryTestHost(t, promptRetryScript{
		responses: []promptRetryResponse{{stopReason: "end_turn"}},
	})
	capture := wireUsageProbeControlPlane(t, host)
	host.storeCredentialAttribution("openai-codex", &agentCredential{
		credentialSource: "user", credentialReference: "cc_credentials:codex-1", credentialGeneration: 1, credentialProvider: "openai", providerMode: "direct",
	})
	host.mu.Lock()
	host.setSessionIDLocked(testCodexThreadID)
	host.mu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var readerCtxErr atomic.Value
	host.codexRolloutReader = func(readCtx context.Context, _ string) ([]byte, error) {
		// By now the caller's context is cancelled; the probe's must not be.
		<-ctx.Done()
		readerCtxErr.Store(readCtx.Err() == nil)
		return []byte(codexRolloutFixture), nil
	}

	var completed sync.WaitGroup
	completed.Add(1)
	host.config.OnPromptComplete = func(string, error) {
		defer completed.Done()
		cancel()
	}
	host.HandlePrompt(ctx, json.RawMessage(`1`), promptRetryParams(), "viewer-1", false)
	completed.Wait()

	payload := capture.waitForPayload(t, 5*time.Second)
	if alive, _ := readerCtxErr.Load().(bool); !alive {
		t.Fatal("probe context was cancelled along with the prompt context")
	}
	if payload.Source != "vm-agent.codex_rollout" {
		t.Fatalf("payload source = %q", payload.Source)
	}
}

// Teardown control for rule 71: stopping the host cancels an in-flight probe
// and no report is posted afterwards.
func TestStopCancelsInFlightProbe(t *testing.T) {
	host := newTestSessionHost(t)
	capture := wireUsageProbeControlPlane(t, host)
	host.storeCredentialAttribution("openai-codex", &agentCredential{credentialSource: "user", credentialReference: "cc_credentials:x", credentialProvider: "openai", providerMode: "direct"})
	host.mu.Lock()
	host.setSessionIDLocked(testCodexThreadID)
	host.mu.Unlock()
	host.config.UsageProbeTimeout = 5 * time.Second

	cancelled := make(chan struct{})
	host.codexRolloutReader = func(ctx context.Context, _ string) ([]byte, error) {
		<-ctx.Done()
		close(cancelled)
		return []byte(codexRolloutFixture), nil
	}
	if !host.scheduleProviderUsageProbe() {
		t.Fatal("probe must start")
	}
	host.Stop()
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("Stop() did not cancel the in-flight probe")
	}
	time.Sleep(50 * time.Millisecond)
	if capture.count() != 0 {
		t.Fatalf("no report must be posted after Stop(), got %d", capture.count())
	}
}

// A prompt that fails after retries must not sample usage; only successful
// completions do. Liveness: the failure itself is still reported.
func TestErroredCodexPromptDoesNotProbe(t *testing.T) {
	host, _ := newPromptRetryTestHost(t, promptRetryScript{
		responses: []promptRetryResponse{
			{errMessage: `Internal error: API Error: 529 overloaded_error`},
			{errMessage: `Internal error: API Error: 529 overloaded_error`},
			{errMessage: `Internal error: API Error: 529 overloaded_error`},
		},
	})
	capture := wireUsageProbeControlPlane(t, host)
	host.storeCredentialAttribution("openai-codex", &agentCredential{
		credentialSource: "user", credentialReference: "cc_credentials:codex-1", credentialProvider: "openai", providerMode: "direct",
	})
	host.mu.Lock()
	host.setSessionIDLocked(testCodexThreadID)
	host.mu.Unlock()
	var reads atomic.Int32
	host.codexRolloutReader = func(context.Context, string) ([]byte, error) {
		reads.Add(1)
		return []byte(codexRolloutFixture), nil
	}

	var completed sync.WaitGroup
	completed.Add(1)
	var promptErr atomic.Value
	host.config.OnPromptComplete = func(_ string, err error) {
		defer completed.Done()
		promptErr.Store(err != nil)
	}
	host.HandlePrompt(context.Background(), json.RawMessage(`1`), promptRetryParams(), "viewer-1", false)
	completed.Wait()
	time.Sleep(50 * time.Millisecond)

	if failed, _ := promptErr.Load().(bool); !failed {
		t.Fatal("liveness: the exhausted prompt must complete with an error")
	}
	if reads.Load() != 0 || capture.count() != 0 {
		t.Fatalf("errored prompt probed: reads=%d posts=%d", reads.Load(), capture.count())
	}
}
