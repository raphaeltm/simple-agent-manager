package acp

import (
	"encoding/json"
	"math"
	"strings"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// Claude Code reports its subscription windows on the ACP stream: claude-agent-acp
// forwards each Claude Code rate_limit_event as a usage_update whose
// _meta["_claude/rateLimit"] carries the event's rate_limit_info. This file turns
// that metadata into credential usage-limit observations.

const claudeRateLimitMetaKey = "_claude/rateLimit"

func (h *SessionHost) prepareUsageReport(params acpsdk.SessionNotification) (usageReportRequest, bool) {
	attr, ok := h.credentialAttributionSnapshot()
	return h.prepareUsageReportWithAttribution(params, attr, ok)
}

func (h *SessionHost) prepareUsageReportWithAttribution(params acpsdk.SessionNotification, attr credentialAttribution, hasAttr bool) (usageReportRequest, bool) {
	meta, ok := claudeRateLimitMeta(params)
	if !ok {
		return usageReportRequest{}, false
	}

	observedAt := h.now().UnixMilli()
	limits := usageLimitsFromClaudeRateLimit(meta, observedAt)
	if len(limits) == 0 {
		return usageReportRequest{}, false
	}
	return h.buildUsageReportRequest(attr, hasAttr, "claude-acp.usage_update", observedAt, limits)
}

func claudeRateLimitMeta(params acpsdk.SessionNotification) (map[string]any, bool) {
	usage := params.Update.UsageUpdate
	if usage == nil {
		return nil, false
	}
	value, ok := usage.Meta[claudeRateLimitMetaKey]
	if !ok {
		return nil, false
	}
	meta, ok := value.(map[string]any)
	return meta, ok
}

func usageLimitFromClaudeRateLimit(meta map[string]any, observedAt int64) (usageLimitPayload, bool) {
	rateLimitType := stringField(meta, "rateLimitType", "rate_limit_type", "type")
	if rateLimitType == "" {
		return usageLimitPayload{}, false
	}
	status := normalizeUsageLimitStatus(stringField(meta, "status"))
	utilizationPercent, hasUtilization := utilizationPercentField(meta, "utilization")
	resetsAt := resetMillisField(meta, "resetsAt", "resets_at", "resetAt", "reset_at")
	windowMinutes := claudeWindowMinutes(rateLimitType)
	freshnessMs := int64(0)

	if status == "" && !hasUtilization && resetsAt == nil {
		return usageLimitPayload{}, false
	}
	if status == "" {
		status = "unknown"
	}

	return usageLimitPayload{
		WindowType:         "claude." + safeUsageIdentifier(rateLimitType),
		Provider:           "anthropic",
		Source:             "claude-acp.rate_limit",
		Status:             status,
		UtilizationPercent: utilizationPercent,
		WindowMinutes:      windowMinutes,
		ResetsAt:           resetsAt,
		ObservedAt:         observedAt,
		FreshnessMs:        &freshnessMs,
	}, true
}

// claudeUnifiedWindowNames are the windows read from rate_limit_info.unifiedWindows,
// in report order. Claude Code (2.1.281) attaches every window it tracks there —
// five_hour, seven_day and seven_day_overage_included — on each rate-limit event.
// Only the windows SAM's credential-limit allowlist accepts are read.
var claudeUnifiedWindowNames = []string{"five_hour", "seven_day"}

// usageLimitsFromClaudeRateLimit turns one rate_limit_info into every window it
// describes. The top-level fields describe only the representative window (the
// one closest to its limit) and carry utilization only once that window is in a
// warning state, so in normal use the five-hour and weekly percentages exist only
// in unifiedWindows. The representative window keeps the top-level status; a
// representative window absent from unifiedWindows (weekly Opus or Sonnet) is
// reported from the top-level fields alone. Payloads without unifiedWindows (older
// Claude Code) produce the single top-level window, exactly as before.
func usageLimitsFromClaudeRateLimit(meta map[string]any, observedAt int64) []usageLimitPayload {
	representative, hasRepresentative := usageLimitFromClaudeRateLimit(meta, observedAt)
	unifiedWindows, _ := meta["unifiedWindows"].(map[string]any)
	accountStatus := normalizeUsageLimitStatus(stringField(meta, "status"))

	limits := make([]usageLimitPayload, 0, len(claudeUnifiedWindowNames)+1)
	representativeReported := false
	for _, name := range claudeUnifiedWindowNames {
		window, ok := unifiedWindows[name].(map[string]any)
		if !ok {
			continue
		}
		limit, ok := usageLimitFromClaudeUnifiedWindow(name, window, accountStatus, observedAt)
		if !ok {
			continue
		}
		if hasRepresentative && representative.WindowType == limit.WindowType {
			limit.Status = representative.Status
			if limit.UtilizationPercent == nil {
				limit.UtilizationPercent = representative.UtilizationPercent
			}
			if limit.ResetsAt == nil {
				limit.ResetsAt = representative.ResetsAt
			}
			representativeReported = true
		}
		limits = append(limits, limit)
	}
	if hasRepresentative && !representativeReported {
		limits = append(limits, representative)
	}
	return limits
}

// usageLimitFromClaudeUnifiedWindow reads one unifiedWindows entry:
// {utilization: fraction of the window used, resetsAt: unix seconds}. Claude Code
// reports a status only for the representative window. Any other window is not
// what is limiting the account, so it is "allowed" while the account is allowed;
// once the account is rejected SAM cannot tell which other windows are exhausted,
// so they are "unknown" and their level comes from utilization alone.
func usageLimitFromClaudeUnifiedWindow(name string, window map[string]any, accountStatus string, observedAt int64) (usageLimitPayload, bool) {
	utilizationPercent, hasUtilization := utilizationPercentField(window, "utilization")
	resetsAt := resetMillisField(window, "resetsAt", "resets_at")
	if !hasUtilization && resetsAt == nil {
		return usageLimitPayload{}, false
	}
	status := "unknown"
	if accountStatus == "allowed" || accountStatus == "allowed_warning" {
		status = "allowed"
	}
	freshnessMs := int64(0)
	return usageLimitPayload{
		WindowType:         "claude." + name,
		Provider:           "anthropic",
		Source:             "claude-acp.rate_limit",
		Status:             status,
		UtilizationPercent: utilizationPercent,
		WindowMinutes:      claudeWindowMinutes(name),
		ResetsAt:           resetsAt,
		ObservedAt:         observedAt,
		FreshnessMs:        &freshnessMs,
	}, true
}

func stringField(values map[string]any, keys ...string) string {
	for _, key := range keys {
		value, ok := values[key]
		if !ok {
			continue
		}
		if text, ok := value.(string); ok {
			return strings.TrimSpace(text)
		}
	}
	return ""
}

func normalizeUsageLimitStatus(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "allowed":
		return "allowed"
	case "allowed_warning", "allowed-warning", "warning":
		return "allowed_warning"
	case "rejected", "blocked", "denied":
		return "rejected"
	case "unknown":
		return "unknown"
	default:
		return ""
	}
}

// utilizationPercentField converts Claude's rate-limit utilization to a percent.
// Claude Code reports it as the fraction of the window used (0..1, read from the
// anthropic-ratelimit-unified-*-utilization headers) and its own status line
// renders round(x*1000)/10; the same rounding here keeps float noise
// (0.13*100 = 13.000000000000002) out of the report. A fraction above 1 means the
// window is over its limit and clamps to 100.
func utilizationPercentField(values map[string]any, key string) (*float64, bool) {
	value, ok := values[key]
	if !ok {
		return nil, false
	}
	number, ok := numberFromJSON(value)
	if !ok {
		return nil, false
	}
	number = math.Round(number*1000) / 10
	if number < 0 {
		number = 0
	}
	if number > 100 {
		number = 100
	}
	return &number, true
}

func numberFromJSON(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

func resetMillisField(values map[string]any, keys ...string) *int64 {
	for _, key := range keys {
		value, ok := values[key]
		if !ok {
			continue
		}
		switch typed := value.(type) {
		case string:
			if parsed, err := time.Parse(time.RFC3339Nano, typed); err == nil {
				ms := parsed.UnixMilli()
				return &ms
			}
		default:
			if number, ok := numberFromJSON(typed); ok && number >= 0 {
				ms := int64(number * 1000)
				return &ms
			}
		}
	}
	return nil
}

func claudeWindowMinutes(rateLimitType string) *int64 {
	normalized := strings.ToLower(rateLimitType)
	if strings.Contains(normalized, "five") && strings.Contains(normalized, "hour") {
		minutes := int64(5 * 60)
		return &minutes
	}
	if strings.Contains(normalized, "seven") && strings.Contains(normalized, "day") {
		minutes := int64(7 * 24 * 60)
		return &minutes
	}
	return nil
}

func safeUsageIdentifier(value string) string {
	var builder strings.Builder
	lastSeparator := false
	for _, r := range strings.ToLower(value) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			builder.WriteRune(r)
			lastSeparator = false
			continue
		}
		if r == '_' || r == '-' || r == '.' {
			if builder.Len() > 0 && !lastSeparator {
				builder.WriteRune('_')
				lastSeparator = true
			}
		}
	}
	result := strings.Trim(builder.String(), "_")
	if result == "" {
		return "unknown"
	}
	return result
}
