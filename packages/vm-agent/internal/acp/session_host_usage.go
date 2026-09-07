package acp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

const claudeRateLimitMetaKey = "_claude/rateLimit"

type credentialAttribution struct {
	AgentType           string
	CredentialSource    string
	CredentialReference string
	CredentialProvider  string
	ProviderMode        string
}

type usageLimitPayload struct {
	WindowType         string   `json:"windowType"`
	Provider           string   `json:"provider,omitempty"`
	Source             string   `json:"source,omitempty"`
	Status             string   `json:"status,omitempty"`
	UtilizationPercent *float64 `json:"utilizationPercent,omitempty"`
	LimitAmount        *int64   `json:"limitAmount,omitempty"`
	RemainingAmount    *int64   `json:"remainingAmount,omitempty"`
	WindowMinutes      *int64   `json:"windowMinutes,omitempty"`
	ResetsAt           *int64   `json:"resetsAt,omitempty"`
	ObservedAt         int64    `json:"observedAt,omitempty"`
	FreshnessMs        *int64   `json:"freshnessMs,omitempty"`
}

type usageReportPayload struct {
	NodeID              string              `json:"nodeId"`
	AgentType           string              `json:"agentType,omitempty"`
	CredentialReference string              `json:"credentialReference,omitempty"`
	CredentialSource    string              `json:"credentialSource,omitempty"`
	ObservedAt          int64               `json:"observedAt,omitempty"`
	Source              string              `json:"source,omitempty"`
	RateLimits          []usageLimitPayload `json:"rateLimits"`
}

type usageReportRequest struct {
	url           string
	callbackToken string
	payload       usageReportPayload
}

func (h *SessionHost) storeCredentialAttribution(agentType string, cred *agentCredential) {
	if cred == nil || cred.credentialReference == "" || cred.credentialSource == "" {
		return
	}
	h.credentialAttribution.Store(credentialAttribution{
		AgentType:           agentType,
		CredentialSource:    cred.credentialSource,
		CredentialReference: cred.credentialReference,
		CredentialProvider:  cred.credentialProvider,
		ProviderMode:        cred.providerMode,
	})
}

func (h *SessionHost) credentialAttributionSnapshot() (credentialAttribution, bool) {
	raw := h.credentialAttribution.Load()
	attr, ok := raw.(credentialAttribution)
	if !ok || attr.CredentialReference == "" || attr.CredentialSource == "" {
		return credentialAttribution{}, false
	}
	return attr, true
}

func (h *SessionHost) captureSessionUsageUpdate(params acpsdk.SessionNotification) {
	request, ok := h.prepareUsageReport(params)
	if !ok {
		return
	}
	h.enqueueUsageReport(request)
}

func (h *SessionHost) prepareUsageReport(params acpsdk.SessionNotification) (usageReportRequest, bool) {
	projectID := h.config.ProjectID
	nodeID := h.config.NodeID
	controlPlaneURL := h.config.ControlPlaneURL
	callbackToken := h.config.CallbackToken
	sessionID := h.config.SessionID
	if projectID == "" || nodeID == "" || controlPlaneURL == "" || sessionID == "" || callbackToken == "" {
		return usageReportRequest{}, false
	}

	attr, ok := h.credentialAttributionSnapshot()
	if !ok {
		return usageReportRequest{}, false
	}

	meta, ok := claudeRateLimitMeta(params)
	if !ok {
		return usageReportRequest{}, false
	}

	observedAt := h.now().UnixMilli()
	limit, ok := usageLimitFromClaudeRateLimit(meta, observedAt)
	if !ok {
		return usageReportRequest{}, false
	}

	payload := usageReportPayload{
		NodeID:              nodeID,
		AgentType:           attr.AgentType,
		CredentialReference: attr.CredentialReference,
		CredentialSource:    attr.CredentialSource,
		ObservedAt:          observedAt,
		Source:              "claude-acp.usage_update",
		RateLimits:          []usageLimitPayload{limit},
	}
	return usageReportRequest{
		url: strings.TrimRight(controlPlaneURL, "/") +
			"/api/projects/" + projectID + "/acp-sessions/" + sessionID + "/usage",
		callbackToken: callbackToken,
		payload:       payload,
	}, true
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

func (h *SessionHost) enqueueUsageReport(request usageReportRequest) {
	h.usageReportMu.Lock()
	h.usageReportPending = &request
	if h.usageReportRunning {
		h.usageReportMu.Unlock()
		return
	}
	h.usageReportRunning = true
	done := make(chan struct{})
	h.usageReportDone = done
	h.usageReportMu.Unlock()

	go h.runUsageReporter(done)
}

func (h *SessionHost) runUsageReporter(done chan struct{}) {
	defer close(done)
	for {
		h.usageReportMu.Lock()
		pending := h.usageReportPending
		if pending == nil {
			h.usageReportRunning = false
			h.usageReportMu.Unlock()
			return
		}
		request := *pending
		h.usageReportPending = nil
		h.usageReportMu.Unlock()

		h.sendUsageReportWithContext(h.ctx, request)
	}
}

func (h *SessionHost) flushUsageReports(timeout time.Duration) bool {
	if timeout <= 0 {
		timeout = h.activityReportTimeout()
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		h.usageReportMu.Lock()
		if !h.usageReportRunning {
			h.usageReportMu.Unlock()
			return true
		}
		done := h.usageReportDone
		h.usageReportMu.Unlock()

		if done == nil {
			return true
		}
		select {
		case <-done:
			continue
		case <-timer.C:
			return false
		}
	}
}

func (h *SessionHost) sendUsageReport(request usageReportRequest) bool {
	return h.sendUsageReportWithContext(context.Background(), request)
}

func (h *SessionHost) sendUsageReportWithContext(ctx context.Context, request usageReportRequest) bool {
	if ctx == nil {
		ctx = context.Background()
	}
	body, err := json.Marshal(request.payload)
	if err != nil {
		slog.Warn("usageReport: marshal failed", "error", err)
		return false
	}

	attempts, retryBackoff := h.usageReportRetryPolicy()
	for attempt := 1; attempt <= attempts; attempt++ {
		if ctx.Err() != nil {
			return false
		}
		statusCode, responseBody, doErr := h.doUsageRequest(ctx, request.url, body, request.callbackToken)
		if doErr != nil {
			if attempt < attempts {
				slog.Info("usageReport: attempt failed, retrying", "attempt", attempt, "error", doErr)
				if !sleepUsageRetry(ctx, retryBackoff) {
					return false
				}
				continue
			}
			slog.Warn("usageReport: all attempts failed", "error", doErr)
			return false
		}
		if statusCode >= 500 && attempt < attempts {
			slog.Info("usageReport: server error, retrying", "status", statusCode)
			if !sleepUsageRetry(ctx, retryBackoff) {
				return false
			}
			continue
		}
		if statusCode >= 400 {
			slog.Warn("usageReport: non-2xx response",
				"status", statusCode,
				"response", truncateString(redactAgentDiagnosticText(responseBody), 512))
			return false
		}
		return true
	}
	return false
}

func sleepUsageRetry(ctx context.Context, delay time.Duration) bool {
	if delay <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (h *SessionHost) usageReportRetryPolicy() (int, time.Duration) {
	attempts := h.config.TerminalActivityReportAttempts
	if attempts <= 0 {
		attempts = 3
	}
	backoff := h.config.TerminalActivityReportBackoff
	if backoff <= 0 {
		backoff = time.Second
	}
	return attempts, backoff
}

func (h *SessionHost) doUsageRequest(parentCtx context.Context, url string, body []byte, callbackToken string) (int, string, error) {
	ctx, cancel := context.WithTimeout(parentCtx, h.activityReportTimeout())
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, "", fmt.Errorf("create usage request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+callbackToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := h.httpClient().Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()

	responseBody, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	return resp.StatusCode, string(responseBody), nil
}
