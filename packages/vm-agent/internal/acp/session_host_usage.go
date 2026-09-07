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
	AgentType            string
	CredentialSource     string
	CredentialReference  string
	CredentialGeneration int64
	CredentialProvider   string
	ProviderMode         string
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
	NodeID               string              `json:"nodeId"`
	AgentType            string              `json:"agentType,omitempty"`
	CredentialReference  string              `json:"credentialReference,omitempty"`
	CredentialSource     string              `json:"credentialSource,omitempty"`
	CredentialGeneration int64               `json:"credentialGeneration"`
	ObservedAt           int64               `json:"observedAt,omitempty"`
	Source               string              `json:"source,omitempty"`
	RateLimits           []usageLimitPayload `json:"rateLimits"`
}

type usageReportRequest struct {
	url           string
	callbackToken string
	payload       usageReportPayload
}

type usageReportPendingEntry struct {
	coalesceKey string
	request     usageReportRequest
}

func (h *SessionHost) storeCredentialAttribution(agentType string, cred *agentCredential) {
	if cred == nil || cred.credentialReference == "" || cred.credentialSource == "" {
		// A replacement connection without attribution must not inherit the
		// previous credential. Existing clients retain their own immutable snapshot.
		h.credentialAttribution.Store(credentialAttribution{})
		return
	}
	h.credentialAttribution.Store(credentialAttribution{
		AgentType:            agentType,
		CredentialSource:     cred.credentialSource,
		CredentialReference:  cred.credentialReference,
		CredentialGeneration: cred.credentialGeneration,
		CredentialProvider:   cred.credentialProvider,
		ProviderMode:         cred.providerMode,
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

func (h *SessionHost) captureSessionUsageUpdate(params acpsdk.SessionNotification, attr credentialAttribution, hasAttr bool) {
	if !h.beginUsageReportCallback() {
		return
	}
	defer h.finishUsageReportCallback()

	request, ok := h.prepareUsageReportWithAttribution(params, attr, hasAttr)
	if !ok {
		return
	}
	h.enqueueUsageReportFromActiveCallback(request)
}

func (h *SessionHost) prepareUsageReport(params acpsdk.SessionNotification) (usageReportRequest, bool) {
	attr, ok := h.credentialAttributionSnapshot()
	return h.prepareUsageReportWithAttribution(params, attr, ok)
}

func (h *SessionHost) prepareUsageReportWithAttribution(params acpsdk.SessionNotification, attr credentialAttribution, hasAttr bool) (usageReportRequest, bool) {
	projectID := h.config.ProjectID
	nodeID := h.config.NodeID
	controlPlaneURL := h.config.ControlPlaneURL
	callbackToken := h.config.CallbackToken
	sessionID := h.config.SessionID
	if projectID == "" || nodeID == "" || controlPlaneURL == "" || sessionID == "" || callbackToken == "" {
		return usageReportRequest{}, false
	}

	if !hasAttr || attr.CredentialReference == "" || attr.CredentialSource == "" {
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
		NodeID:               nodeID,
		AgentType:            attr.AgentType,
		CredentialReference:  attr.CredentialReference,
		CredentialSource:     attr.CredentialSource,
		CredentialGeneration: attr.CredentialGeneration,
		ObservedAt:           observedAt,
		Source:               "claude-acp.usage_update",
		RateLimits:           []usageLimitPayload{limit},
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
	h.enqueueUsageReportRequest(request, false)
}

func (h *SessionHost) enqueueUsageReportFromActiveCallback(request usageReportRequest) {
	h.enqueueUsageReportRequest(request, true)
}

func (h *SessionHost) enqueueUsageReportRequest(request usageReportRequest, allowClosedGrace bool) {
	h.usageReportMu.Lock()
	if h.usageReportClosed && (!allowClosedGrace || !h.usageReportCloseGrace) {
		h.recordUsageReportFailureLocked("usage report ingress closed")
		h.usageReportMu.Unlock()
		slog.Warn("usageReport: dropped report after ingress closed")
		return
	}
	if h.usageReportPending == nil {
		h.usageReportPending = make(map[string]usageReportPendingEntry)
	}
	if !h.usageReportRunning && len(h.usageReportPending) == 0 {
		h.usageReportFailureCount = 0
		h.usageReportLastError = ""
	}
	coalesceKey := usageReportCoalesceKey(request)
	if len(h.usageReportOrder) > 0 {
		lastKey := h.usageReportOrder[len(h.usageReportOrder)-1]
		if entry, exists := h.usageReportPending[lastKey]; exists && entry.coalesceKey == coalesceKey {
			h.usageReportPending[lastKey] = usageReportPendingEntry{
				coalesceKey: coalesceKey,
				request:     request,
			}
			h.usageReportMu.Unlock()
			return
		}
	}
	key := fmt.Sprintf("%020d", h.usageReportNextSeq)
	h.usageReportNextSeq++
	h.usageReportOrder = append(h.usageReportOrder, key)
	h.usageReportPending[key] = usageReportPendingEntry{
		coalesceKey: coalesceKey,
		request:     request,
	}
	limit := h.usageReportPendingLimit()
	for len(h.usageReportOrder) > limit {
		evicted := h.usageReportOrder[0]
		h.usageReportOrder = h.usageReportOrder[1:]
		if _, exists := h.usageReportPending[evicted]; exists {
			delete(h.usageReportPending, evicted)
			h.recordUsageReportFailureLocked("usage report pending capacity exceeded")
			slog.Warn("usageReport: pending report evicted due to capacity", "pendingLimit", limit)
		}
	}
	if h.usageReportRunning {
		h.usageReportMu.Unlock()
		return
	}
	h.usageReportRunning = true
	reporterCtx, cancel := context.WithCancel(context.Background())
	h.usageReportCancel = cancel
	done := make(chan struct{})
	h.usageReportDone = done
	h.usageReportMu.Unlock()

	go h.runUsageReporter(reporterCtx, done)
}

func removeUsageReportOrderKey(order []string, key string) []string {
	next := order[:0]
	for _, existing := range order {
		if existing != key {
			next = append(next, existing)
		}
	}
	return next
}

func (h *SessionHost) runUsageReporter(ctx context.Context, done chan struct{}) {
	defer close(done)
	for {
		request, ok := h.nextUsageReport()
		if !ok {
			return
		}

		if !h.sendUsageReportWithContext(ctx, request) {
			h.recordUsageReportFailure("usage report delivery failed")
		}
	}
}

func (h *SessionHost) nextUsageReport() (usageReportRequest, bool) {
	h.usageReportMu.Lock()
	defer h.usageReportMu.Unlock()
	for len(h.usageReportOrder) > 0 {
		key := h.usageReportOrder[0]
		h.usageReportOrder = h.usageReportOrder[1:]
		entry, ok := h.usageReportPending[key]
		if !ok {
			continue
		}
		delete(h.usageReportPending, key)
		return entry.request, true
	}
	h.usageReportRunning = false
	h.usageReportCancel = nil
	return usageReportRequest{}, false
}

func (h *SessionHost) recordUsageReportFailure(message string) {
	h.usageReportMu.Lock()
	h.recordUsageReportFailureLocked(message)
	h.usageReportMu.Unlock()
}

func (h *SessionHost) recordUsageReportFailureLocked(message string) {
	h.usageReportFailureCount++
	h.usageReportLastError = message
}

func (h *SessionHost) closeUsageReportIngress() {
	h.usageReportMu.Lock()
	h.usageReportClosed = true
	h.usageReportCloseGrace = true
	h.usageReportMu.Unlock()
}

func (h *SessionHost) beginUsageReportCallback() bool {
	h.usageReportMu.Lock()
	defer h.usageReportMu.Unlock()
	if h.usageReportClosed {
		return false
	}
	h.usageReportCallbacks.Add(1)
	return true
}

func (h *SessionHost) finishUsageReportCallback() {
	h.usageReportCallbacks.Done()
}

func (h *SessionHost) waitForUsageReportCallbacks(timeout time.Duration) error {
	if timeout <= 0 {
		timeout = h.activityReportTimeout()
	}
	done := make(chan struct{})
	go func() {
		h.usageReportCallbacks.Wait()
		close(done)
	}()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
		h.usageReportMu.Lock()
		h.usageReportCloseGrace = false
		h.usageReportMu.Unlock()
		return nil
	case <-timer.C:
		h.usageReportMu.Lock()
		h.usageReportCloseGrace = false
		h.recordUsageReportFailureLocked("usage report callback drain timed out")
		h.usageReportMu.Unlock()
		return fmt.Errorf("usage report callback drain timed out after %s", timeout)
	}
}

func (h *SessionHost) flushUsageReports(timeout time.Duration) error {
	if timeout <= 0 {
		timeout = h.activityReportTimeout()
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		h.usageReportMu.Lock()
		if !h.usageReportRunning {
			err := h.usageReportDrainErrorLocked()
			h.usageReportMu.Unlock()
			return err
		}
		done := h.usageReportDone
		cancel := h.usageReportCancel
		h.usageReportMu.Unlock()

		if done == nil {
			return fmt.Errorf("usage report flush missing completion signal")
		}
		select {
		case <-done:
			continue
		case <-timer.C:
			if cancel != nil {
				cancel()
			}
			return fmt.Errorf("usage report flush timed out after %s", timeout)
		}
	}
}

func (h *SessionHost) usageReportDrainErrorLocked() error {
	if h.usageReportFailureCount == 0 {
		return nil
	}
	return fmt.Errorf("%d usage report(s) failed; last error: %s", h.usageReportFailureCount, h.usageReportLastError)
}

func (h *SessionHost) usageReportPendingLimit() int {
	if h.config.UsageReportPendingLimit > 0 {
		return h.config.UsageReportPendingLimit
	}
	return DefaultUsageReportPendingWindows
}

func usageReportCoalesceKey(request usageReportRequest) string {
	limit := usageLimitPayload{}
	if len(request.payload.RateLimits) > 0 {
		limit = request.payload.RateLimits[0]
	}
	return strings.Join([]string{
		request.url,
		request.payload.AgentType,
		request.payload.CredentialSource,
		request.payload.CredentialReference,
		request.payload.Source,
		limit.Provider,
		limit.Source,
		limit.WindowType,
		limit.Status,
		float64PointerKey(limit.UtilizationPercent),
		int64PointerKey(limit.LimitAmount),
		int64PointerKey(limit.RemainingAmount),
		int64PointerKey(limit.WindowMinutes),
		int64PointerKey(limit.ResetsAt),
	}, "\x1f")
}

func float64PointerKey(value *float64) string {
	if value == nil {
		return ""
	}
	return fmt.Sprintf("%.17g", *value)
}

func int64PointerKey(value *int64) string {
	if value == nil {
		return ""
	}
	return fmt.Sprintf("%d", *value)
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
