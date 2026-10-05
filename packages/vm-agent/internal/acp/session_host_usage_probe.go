package acp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

// Post-turn provider usage probes.
//
// Claude Code reports its subscription windows on the ACP stream
// (`usage_update._meta["_claude/rateLimit"]`, see session_host_usage.go). The
// other two harnesses SAM runs do not:
//
//   - Codex (codex-acp 2.1.1) keeps `account/rateLimits/updated` in adapter
//     state and only renders it for `/status`. The pinned Codex CLI does persist
//     every `token_count` event, including `rate_limits`, to the session rollout
//     JSONL, so after each completed turn the agent reads the tail of that file.
//   - OpenCode exposes nothing over ACP. OpenCode Go has an official usage
//     endpoint keyed by the API key the session already runs with.
//
// Both probes run once per completed prompt, single-flight, bounded by
// UsageProbeTimeout and derived from the host lifecycle context (never from a
// prompt's request context, rule 71). Results flow through the same coalescing
// usage reporter as the Claude samples.

const (
	sourceCodexRollout       = "vm-agent.codex_rollout"
	sourceOpenCodeGoUsage    = "vm-agent.opencode_go_usage"
	providerOpenAI           = "openai"
	providerOpenCode         = "opencode"
	codexRolloutTailBytes    = 256 * 1024
	openCodeUsageMaxBodySize = 64 * 1024
	opencodeProviderGo       = "opencode-go"
)

// codexThreadIDPattern accepts the UUID thread ids Codex uses in rollout file
// names. The id is interpolated into a shell `find -name` pattern, so anything
// else is rejected before it reaches a shell.
var codexThreadIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// codexRolloutTailScript locates the newest rollout for thread `$1` under the
// Codex home (CODEX_HOME when set, else ~/.codex) and prints its last bytes. The
// thread id is passed as a positional argument, never spliced into the script.
// `rollout-<timestamp>-<thread>[_<rollout>].jsonl` is the documented name shape.
// The byte bound is codexRolloutTailBytes so the two cannot drift apart.
var codexRolloutTailScript = fmt.Sprintf(`d="${CODEX_HOME:-$HOME/.codex}/sessions"
[ -d "$d" ] || exit 0
f=$(find "$d" -type f -name "rollout-*-$1*.jsonl" 2>/dev/null | sort | tail -n 1)
[ -n "$f" ] || exit 0
tail -c %d -- "$f"`, codexRolloutTailBytes)

// codexRolloutTailReader returns the trailing bytes of the rollout file for a
// Codex thread. Tests inject a fake; production picks container or local mode.
type codexRolloutTailReader func(ctx context.Context, threadID string) ([]byte, error)

type codexRolloutLine struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

type codexTokenCountPayload struct {
	Type       string                  `json:"type"`
	RateLimits *codexRateLimitSnapshot `json:"rate_limits"`
}

type codexRateLimitSnapshot struct {
	Primary   *codexRateLimitWindow `json:"primary"`
	Secondary *codexRateLimitWindow `json:"secondary"`
	// RateLimitReachedType is set by Codex when a limit is already enforced,
	// possibly below 100% used_percent. Its value names the window ("primary",
	// "secondary") in the pinned CLI; any other non-null value marks both.
	RateLimitReachedType json.RawMessage `json:"rate_limit_reached_type"`
	// SpendControlReached marks an organisation spend cap; every window is
	// then rejected regardless of utilization.
	SpendControlReached *bool `json:"spend_control_reached"`
}

type codexRateLimitWindow struct {
	UsedPercent   float64 `json:"used_percent"`
	WindowMinutes *int64  `json:"window_minutes"`
	// ResetsAt is a unix timestamp in seconds.
	ResetsAt *int64 `json:"resets_at"`
}

type openCodeGoUsageResponse struct {
	Usage map[string]openCodeGoUsageWindow `json:"usage"`
}

type openCodeGoUsageWindow struct {
	Status   string   `json:"status"`
	Percent  *float64 `json:"percent"`
	ResetsAt string   `json:"resetsAt"`
}

// openCodeGoWindows are the only windows the Go plan documents; anything else
// in the response is ignored rather than guessed at.
var openCodeGoWindows = []string{"rolling", "weekly", "monthly"}

func (h *SessionHost) usageProbeTimeout() time.Duration {
	if h.config.UsageProbeTimeout > 0 {
		return h.config.UsageProbeTimeout
	}
	return config.DefaultACPUsageProbeTimeout
}

func (h *SessionHost) openCodeGoUsageURL() string {
	if url := strings.TrimSpace(h.config.OpenCodeGoUsageURL); url != "" {
		return url
	}
	return config.DefaultOpenCodeGoUsageURL
}

// storeOpencodeUsageProbeKey retains the OpenCode Go API key for post-turn
// usage probes. Only a direct (non-proxy) api-key credential driving the
// opencode-go provider qualifies; every other case clears any previous key so a
// provider or credential switch never probes with a stale secret.
func (h *SessionHost) storeOpencodeUsageProbeKey(agentType string, cred *agentCredential, settings *agentSettingsPayload) {
	key := ""
	if agentType == "opencode" && cred != nil && cred.inferenceConfig == nil &&
		cred.credentialKind == "api-key" && settings != nil &&
		normalizeOpencodeProvider(settings.OpencodeProvider) == opencodeProviderGo {
		key = cred.credential
	}
	h.opencodeUsageKey.Store(key)
}

func (h *SessionHost) clearOpencodeUsageProbeKey() {
	h.opencodeUsageKey.Store("")
}

func (h *SessionHost) loadOpencodeUsageProbeKey() string {
	if v, ok := h.opencodeUsageKey.Load().(string); ok {
		return v
	}
	return ""
}

// scheduleProviderUsageProbe runs the provider-specific probe for the current
// agent after a completed turn. It returns true when a probe was started.
func (h *SessionHost) scheduleProviderUsageProbe() bool {
	attr, ok := h.credentialAttributionSnapshot()
	if !ok {
		return false
	}
	var probe func(ctx context.Context) ([]usageLimitPayload, string, bool)
	switch attr.AgentType {
	case "openai-codex":
		threadID := h.loadMirroredSessionID()
		if threadID == "" {
			return false
		}
		probe = func(ctx context.Context) ([]usageLimitPayload, string, bool) {
			limits, ok := h.probeCodexRolloutRateLimits(ctx, threadID)
			return limits, sourceCodexRollout, ok
		}
	case "opencode":
		key := h.loadOpencodeUsageProbeKey()
		if key == "" {
			return false
		}
		probe = func(ctx context.Context) ([]usageLimitPayload, string, bool) {
			limits, ok := h.probeOpenCodeGoUsage(ctx, key)
			return limits, sourceOpenCodeGoUsage, ok
		}
	default:
		return false
	}
	if !h.usageProbeInFlight.CompareAndSwap(false, true) {
		return false
	}
	base := h.lifecycleContext()
	timeout := h.usageProbeTimeout()
	go func() {
		defer h.usageProbeInFlight.Store(false)
		ctx, cancel := context.WithTimeout(base, timeout)
		defer cancel()
		limits, source, ok := probe(ctx)
		if !ok || len(limits) == 0 {
			return
		}
		request, ok := h.buildUsageReportRequest(attr, true, source, h.now().UnixMilli(), limits)
		if !ok {
			return
		}
		h.enqueueUsageReport(request)
	}()
	return true
}

// ─── Codex ───────────────────────────────────────────────────────────────────

func (h *SessionHost) probeCodexRolloutRateLimits(ctx context.Context, threadID string) ([]usageLimitPayload, bool) {
	if !codexThreadIDPattern.MatchString(threadID) {
		slog.Debug("usageProbe: codex thread id is not a UUID, skipping rollout read")
		return nil, false
	}
	reader := h.codexRolloutReader
	if reader == nil {
		reader = h.defaultCodexRolloutTailReader
	}
	tail, err := reader(ctx, threadID)
	if err != nil {
		slog.Debug("usageProbe: codex rollout read failed", "error", err)
		return nil, false
	}
	now := h.now().UnixMilli()
	return parseCodexRolloutRateLimits(tail, now)
}

func (h *SessionHost) defaultCodexRolloutTailReader(ctx context.Context, threadID string) ([]byte, error) {
	if h.config.ProcessLauncher != nil || h.config.ContainerResolver == nil {
		return readLocalCodexRolloutTail(threadID)
	}
	containerID, err := h.config.ContainerResolver()
	if err != nil {
		return nil, fmt.Errorf("resolve container: %w", err)
	}
	stdout, stderr, err := execInContainer(ctx, containerID, h.config.ContainerUser, "",
		"sh", "-c", codexRolloutTailScript, "sh", threadID)
	if err != nil {
		return nil, fmt.Errorf("rollout tail exec: %w (%s)", err, truncateString(stderr, 200))
	}
	return []byte(stdout), nil
}

// readLocalCodexRolloutTail is the standalone (cf-container) implementation:
// the agent and the harness share one filesystem. Like the container script it
// matches on the file name at any depth under sessions/, so both readers keep
// working if Codex ever changes the YYYY/MM/DD nesting.
func readLocalCodexRolloutTail(threadID string) ([]byte, error) {
	sessionsDir, err := resolveLocalAuthFileTargetPath(".codex/sessions")
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(sessionsDir); err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	pattern := "rollout-*-" + threadID + "*.jsonl"
	var matches []string
	walkErr := filepath.WalkDir(sessionsDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		if ok, _ := filepath.Match(pattern, entry.Name()); ok {
			matches = append(matches, path)
		}
		return nil
	})
	if walkErr != nil {
		return nil, walkErr
	}
	if len(matches) == 0 {
		return nil, nil
	}
	sort.Strings(matches)
	file, err := os.Open(matches[len(matches)-1])
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	offset := info.Size() - codexRolloutTailBytes
	if offset < 0 {
		offset = 0
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return nil, err
	}
	return io.ReadAll(io.LimitReader(file, codexRolloutTailBytes))
}

// parseCodexRolloutRateLimits returns the windows from the newest `token_count`
// event in a rollout tail that carries a rate-limit snapshot. Lines that fail to
// parse (including a truncated first line from the tail cut) are skipped.
func parseCodexRolloutRateLimits(tail []byte, now int64) ([]usageLimitPayload, bool) {
	lines := bytes.Split(tail, []byte{'\n'})
	for i := len(lines) - 1; i >= 0; i-- {
		line := bytes.TrimSpace(lines[i])
		if len(line) == 0 {
			continue
		}
		var envelope codexRolloutLine
		if err := json.Unmarshal(line, &envelope); err != nil || envelope.Type != "event_msg" {
			continue
		}
		var payload codexTokenCountPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil || payload.Type != "token_count" {
			continue
		}
		snapshot := payload.RateLimits
		if snapshot == nil || (snapshot.Primary == nil && snapshot.Secondary == nil) {
			continue
		}
		observedAt := now
		if parsed, err := time.Parse(time.RFC3339Nano, envelope.Timestamp); err == nil {
			observedAt = parsed.UnixMilli()
		}
		primaryReached, secondaryReached := codexReachedWindows(snapshot)
		var limits []usageLimitPayload
		if snapshot.Primary != nil {
			limits = append(limits, codexWindowPayload("codex.primary", snapshot.Primary, primaryReached, observedAt, now))
		}
		if snapshot.Secondary != nil {
			limits = append(limits, codexWindowPayload("codex.secondary", snapshot.Secondary, secondaryReached, observedAt, now))
		}
		return limits, true
	}
	return nil, false
}

// codexReachedWindows reports which windows Codex itself marks as enforced.
// rate_limit_reached_type names one window; spend_control_reached or an
// unrecognised reached type marks both, which is the safe direction.
func codexReachedWindows(snapshot *codexRateLimitSnapshot) (primary, secondary bool) {
	if snapshot.SpendControlReached != nil && *snapshot.SpendControlReached {
		return true, true
	}
	raw := bytes.TrimSpace(snapshot.RateLimitReachedType)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) || bytes.Equal(raw, []byte("false")) {
		return false, false
	}
	var name string
	if err := json.Unmarshal(raw, &name); err == nil {
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "primary":
			return true, false
		case "secondary":
			return false, true
		}
	}
	return true, true
}

func codexWindowPayload(windowType string, window *codexRateLimitWindow, reached bool, observedAt, now int64) usageLimitPayload {
	utilization := clampPercent(window.UsedPercent)
	status := "allowed"
	if reached || utilization >= 100 {
		status = "rejected"
	}
	payload := usageLimitPayload{
		WindowType:         windowType,
		Provider:           providerOpenAI,
		Source:             sourceCodexRollout,
		Status:             status,
		UtilizationPercent: &utilization,
		ObservedAt:         observedAt,
		FreshnessMs:        freshnessMillis(observedAt, now),
	}
	if window.WindowMinutes != nil && *window.WindowMinutes > 0 {
		minutes := *window.WindowMinutes
		payload.WindowMinutes = &minutes
	}
	if window.ResetsAt != nil && *window.ResetsAt > 0 {
		resetsAt := *window.ResetsAt * 1000
		payload.ResetsAt = &resetsAt
	}
	return payload
}

// ─── OpenCode Go ─────────────────────────────────────────────────────────────

// openCodeUsageClient is the host's HTTP client with redirects disabled: the
// request carries the OpenCode API key as a bearer token, and Go's client would
// otherwise replay it to whatever host a 3xx points at. A redirect surfaces as
// a non-200 response and the probe reports nothing.
func (h *SessionHost) openCodeUsageClient() *http.Client {
	client := *h.httpClient()
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &client
}

func (h *SessionHost) probeOpenCodeGoUsage(ctx context.Context, apiKey string) ([]usageLimitPayload, bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.openCodeGoUsageURL(), nil)
	if err != nil {
		slog.Debug("usageProbe: opencode request build failed", "error", err)
		return nil, false
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Accept", "application/json")
	resp, err := h.openCodeUsageClient().Do(req)
	if err != nil {
		slog.Debug("usageProbe: opencode usage request failed", "error", err)
		return nil, false
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, openCodeUsageMaxBodySize))
	if err != nil {
		slog.Debug("usageProbe: opencode usage body read failed", "error", err)
		return nil, false
	}
	if resp.StatusCode != http.StatusOK {
		slog.Debug("usageProbe: opencode usage non-200", "status", resp.StatusCode)
		return nil, false
	}
	return parseOpenCodeGoUsage(body, h.now().UnixMilli())
}

// parseOpenCodeGoUsage maps the documented Go windows to usage payloads.
func parseOpenCodeGoUsage(body []byte, now int64) ([]usageLimitPayload, bool) {
	var response openCodeGoUsageResponse
	if err := json.Unmarshal(body, &response); err != nil || len(response.Usage) == 0 {
		return nil, false
	}
	var limits []usageLimitPayload
	for _, name := range openCodeGoWindows {
		window, ok := response.Usage[name]
		if !ok {
			continue
		}
		status := normalizeOpenCodeUsageStatus(window.Status)
		if window.Percent == nil && status == "unknown" {
			continue
		}
		payload := usageLimitPayload{
			WindowType:  "opencode." + name,
			Provider:    providerOpenCode,
			Source:      sourceOpenCodeGoUsage,
			Status:      status,
			ObservedAt:  now,
			FreshnessMs: freshnessMillis(now, now),
		}
		if window.Percent != nil {
			utilization := clampPercent(*window.Percent)
			payload.UtilizationPercent = &utilization
		}
		if parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(window.ResetsAt)); err == nil {
			resetsAt := parsed.UnixMilli()
			payload.ResetsAt = &resetsAt
		}
		limits = append(limits, payload)
	}
	return limits, len(limits) > 0
}

func normalizeOpenCodeUsageStatus(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "ok", "allowed", "active":
		return "allowed"
	case "warning", "warn":
		return "allowed_warning"
	case "exceeded", "limited", "limit_reached", "blocked", "rejected", "exhausted":
		return "rejected"
	default:
		return "unknown"
	}
}

func clampPercent(value float64) float64 {
	if value < 0 || math.IsNaN(value) {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}

func freshnessMillis(observedAt, now int64) *int64 {
	freshness := now - observedAt
	if freshness < 0 {
		freshness = 0
	}
	return &freshness
}
