package acp

import (
	"encoding/json"
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
	limit, ok := usageLimitFromClaudeRateLimit(meta, observedAt)
	if !ok {
		return usageReportRequest{}, false
	}
	return h.buildUsageReportRequest(attr, hasAttr, "claude-acp.usage_update", observedAt, []usageLimitPayload{limit})
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

func utilizationPercentField(values map[string]any, key string) (*float64, bool) {
	value, ok := values[key]
	if !ok {
		return nil, false
	}
	number, ok := numberFromJSON(value)
	if !ok {
		return nil, false
	}
	if number <= 1 {
		number *= 100
	}
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
