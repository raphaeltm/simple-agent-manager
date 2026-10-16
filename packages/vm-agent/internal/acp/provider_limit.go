package acp

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// ProviderLimitError retains only allowlisted recovery metadata. The provider's
// message is deliberately not retained: callbacks, logs and viewers use Error().
type ProviderLimitError struct {
	ResetsAt             *int64
	AgentSessionID       string
	CredentialGeneration int64
	PromptAttemptID      uint64
}

func (e *ProviderLimitError) Error() string { return "provider_limit_reached" }

var limitClockReset = regexp.MustCompile(`(?i)resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)`)

// ClassifyProviderLimit accepts only terminal provider errors, never serialized
// SDK metadata or arbitrary tool output. Pinned Claude ACP uses the synthetic
// limit message as RequestError.Message (not always "Internal error"). Codex
// ACP 2.1.1 carries the app-server's categorical codexErrorInfo in Data.
func ClassifyProviderLimit(err error, now time.Time) *ProviderLimitError {
	if err == nil {
		return nil
	}
	var safe *ProviderLimitError
	if errors.As(err, &safe) {
		return safe
	}
	var request *acpsdk.RequestError
	if errors.As(err, &request) {
		if request.Code != -32603 {
			return nil
		}
		data, _ := request.Data.(map[string]any)
		if data["errorKind"] == "authentication_failed" || data["codexErrorInfo"] == "unauthorized" {
			return nil
		}
		message := request.Message
		nested := message == "Internal error"
		if nested {
			message, _ = data["message"].(string)
		}
		// Only normalize the top-level typed provider SDK label. Nested/tool
		// metadata must not turn a copied plan phrase into provider evidence.
		if !nested && data["errorKind"] == "rate_limit" {
			message = strings.TrimPrefix(message, "Internal error: API Error: ")
			message = strings.TrimPrefix(message, "Internal error: ")
		}
		plan := isPlanLimitMessage(message)
		codex := data["codexErrorInfo"] == "usageLimitExceeded"
		reset := providerLimitReset(data, now)
		if reset == nil && codex {
			reset = codexClockReset(message, now)
		}
		// Pinned Claude ACP prefixes terminal API errors with the SDK's internal
		// error label. Read its reset only from this typed, top-level provider
		// error, never from arbitrary nested metadata or tool text.
		if reset == nil && data["errorKind"] == "rate_limit" && strings.HasPrefix(request.Message, "Internal error: API Error: ") {
			reset = clockReset(request.Message, now)
		}
		// A structured rate_limit without reset/plan evidence remains transient overload.
		if codex || (plan && ((!nested && data["errorKind"] == nil) || data["errorKind"] == "rate_limit")) || (data["errorKind"] == "rate_limit" && reset != nil) {
			if reset == nil {
				reset = clockReset(message, now)
			}
			return &ProviderLimitError{ResetsAt: reset}
		}
		return nil
	}
	text := strings.TrimSpace(strings.SplitN(err.Error(), "\n", 2)[0])
	if text == "provider_limit_reached" {
		return &ProviderLimitError{}
	}
	// Bare provider messages are source-prefixed. Arbitrary MCP/tool text and JSON
	// wrappers cannot become provider evidence by containing a limit phrase.
	if isPlanLimitMessage(text) {
		return &ProviderLimitError{ResetsAt: clockReset(text, now)}
	}
	if strings.HasPrefix(text, "Provider HTTP 429") || strings.HasPrefix(text, "API Error: 429") {
		// Reset-bearing API failures are also allowed to use an ISO timestamp.
		for _, word := range strings.Fields(text) {
			if parsed, e := time.Parse(time.RFC3339, strings.Trim(word, `",;`)); e == nil && parsed.After(now) {
				ms := parsed.UnixMilli()
				return &ProviderLimitError{ResetsAt: &ms}
			}
		}
	}
	return nil
}

func isPlanLimitMessage(message string) bool {
	text := strings.ToLower(message)
	for _, prefix := range []string{"you've hit your session limit", "you’ve hit your session limit", "you've hit your weekly limit", "you’ve hit your weekly limit", "you've hit your usage limit", "you’ve hit your usage limit", "you have hit your usage limit"} {
		if strings.HasPrefix(text, prefix) {
			return true
		}
	}
	return false
}

func providerLimitReset(data map[string]any, now time.Time) *int64 {
	reset := resetMillisField(data, "resetsAt", "resets_at", "resetAt", "reset_at")
	if reset != nil && *reset > now.UnixMilli() {
		return reset
	}
	return nil
}

func clockReset(message string, now time.Time) *int64 {
	match := limitClockReset.FindStringSubmatch(message)
	if match == nil {
		return nil
	}
	hour, _ := strconv.Atoi(match[1])
	minute := 0
	if match[2] != "" {
		minute, _ = strconv.Atoi(match[2])
	}
	if hour < 1 || hour > 12 || minute > 59 {
		return nil
	}
	hour %= 12
	if strings.EqualFold(match[3], "pm") {
		hour += 12
	}
	utc := now.UTC()
	reset := time.Date(utc.Year(), utc.Month(), utc.Day(), hour, minute, 0, 0, time.UTC)
	if !reset.After(now) {
		reset = reset.AddDate(0, 0, 1)
	}
	ms := reset.UnixMilli()
	return &ms
}

var codexRetryClock = regexp.MustCompile(`(?i)try again at\s+(?:([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})\s+)?(\d{1,2}):(\d{2})\s*(am|pm)\.?`)

// The pinned Codex container uses UTC. Only a categorical usageLimitExceeded
// error may consult this provider clock; dates outside the bounded reset horizon
// remain unknown rather than acquiring an invented future date.
func codexClockReset(message string, now time.Time) *int64 {
	match := codexRetryClock.FindStringSubmatch(message)
	if match == nil {
		return nil
	}
	clock := match[4] + ":" + match[5] + " " + strings.ToUpper(match[6])
	var reset time.Time
	var err error
	if match[1] != "" {
		date := match[1] + " " + match[2] + ", " + match[3] + " " + clock
		for _, layout := range []string{"Jan 2, 2006 3:04 PM", "January 2, 2006 3:04 PM"} {
			reset, err = time.Parse(layout, date)
			if err == nil {
				break
			}
		}
		if err != nil {
			return nil
		}
	} else {
		parsed, parseErr := time.Parse("3:04 PM", clock)
		if parseErr != nil {
			return nil
		}
		utc := now.UTC()
		reset = time.Date(utc.Year(), utc.Month(), utc.Day(), parsed.Hour(), parsed.Minute(), 0, 0, time.UTC)
		if !reset.After(now) {
			reset = reset.AddDate(0, 0, 1)
		}
	}
	if !reset.After(now) || reset.Sub(now) > 7*24*time.Hour {
		return nil
	}
	ms := reset.UnixMilli()
	return &ms
}

// Cached observations are bound to the injected credential generation. A
// replacement client must never inherit a rejection from the previous one.
type observedProviderWindow struct {
	observedAt int64
	resetsAt   *int64
	rejected   bool
}
type observedProviderLimit struct {
	reference  string
	generation int64
	windows    map[string]observedProviderWindow
}

const providerLimitObservationFreshness = 2 * time.Minute
const maxObservedProviderWindows = 100

func (h *SessionHost) observeProviderLimitLocked(payload usageReportPayload) {
	attr, ok := h.credentialAttributionSnapshot()
	if !ok || payload.CredentialReference != attr.CredentialReference || payload.CredentialGeneration != attr.CredentialGeneration {
		return
	}
	cached := h.rejectedUsageLimit
	if cached == nil || cached.reference != payload.CredentialReference || cached.generation != payload.CredentialGeneration {
		cached = &observedProviderLimit{reference: payload.CredentialReference, generation: payload.CredentialGeneration, windows: make(map[string]observedProviderWindow)}
		h.rejectedUsageLimit = cached
	}
	for _, limit := range payload.RateLimits {
		observedAt := limit.ObservedAt
		if observedAt <= 0 {
			observedAt = payload.ObservedAt
		}
		if observedAt > h.now().UnixMilli() {
			continue
		}
		previous, exists := cached.windows[limit.WindowType]
		if exists && observedAt <= previous.observedAt {
			continue
		}
		if !exists && len(cached.windows) >= maxObservedProviderWindows {
			continue
		}
		var reset *int64
		if limit.ResetsAt != nil {
			value := *limit.ResetsAt
			reset = &value
		}
		cached.windows[limit.WindowType] = observedProviderWindow{observedAt: observedAt, resetsAt: reset, rejected: limit.Status == "rejected"}
	}
}
func (h *SessionHost) promptProviderLimit(err error, accepted ...credentialAttribution) *ProviderLimitError {
	limit := ClassifyProviderLimit(err, h.now())
	reason := ClassifyPromptError(err)
	if limit == nil && reason != "provider_overloaded" {
		return nil
	}
	attr, ok := h.credentialAttributionSnapshot()
	if limit != nil {
		limit.AgentSessionID = h.config.SessionID
		if ok {
			limit.CredentialGeneration = attr.CredentialGeneration
		}
	}
	if !ok {
		return limit
	}
	if len(accepted) == 1 && (accepted[0].CredentialReference != attr.CredentialReference || accepted[0].CredentialGeneration != attr.CredentialGeneration) {
		return limit
	}
	h.usageReportMu.Lock()
	defer h.usageReportMu.Unlock()
	observation := h.rejectedUsageLimit
	if observation == nil || observation.reference != attr.CredentialReference || observation.generation != attr.CredentialGeneration {
		return limit
	}
	now := h.now().UnixMilli()
	for _, window := range observation.windows {
		if !window.rejected || window.observedAt > now || now-window.observedAt > providerLimitObservationFreshness.Milliseconds() || (window.resetsAt != nil && *window.resetsAt <= now) {
			continue
		}
		if limit == nil {
			limit = &ProviderLimitError{AgentSessionID: h.config.SessionID, CredentialGeneration: attr.CredentialGeneration}
		}
		if window.resetsAt != nil && (limit.ResetsAt == nil || *window.resetsAt > *limit.ResetsAt) {
			reset := *window.resetsAt
			limit.ResetsAt = &reset
		}
	}
	return limit
}
