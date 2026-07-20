package acp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// reportAgentError sends an agent error to boot-log and error reporter.
func (h *SessionHost) reportAgentError(agentType, step, message, detail string) {
	message = redactAgentDiagnosticText(message)
	detail = redactAgentDiagnosticText(detail)
	if h.config.BootLog != nil {
		h.config.BootLog.Log(step, "failed", fmt.Sprintf("[%s] %s", agentType, message), detail)
	}
	if h.config.ErrorReporter != nil {
		h.config.ErrorReporter.ReportError(
			fmt.Errorf("%s", message),
			"session-host",
			h.config.WorkspaceID,
			map[string]interface{}{
				"agentType": agentType,
				"step":      step,
				"detail":    detail,
			},
		)
	}
}

func (h *SessionHost) reportLifecycle(level, message string, ctx map[string]interface{}) {
	if h.config.ErrorReporter == nil {
		return
	}
	switch level {
	case "error":
		h.config.ErrorReporter.ReportError(errors.New(message), "session-host", h.config.WorkspaceID, ctx)
	case "warn":
		h.config.ErrorReporter.ReportWarn(message, "session-host", h.config.WorkspaceID, ctx)
	default:
		// Lifecycle progress and success reports intentionally stay info-level;
		// expected degraded operations should pass "warn" and real failures "error".
		h.config.ErrorReporter.ReportInfo(message, "session-host", h.config.WorkspaceID, ctx)
	}
}

func (h *SessionHost) reportEvent(level, eventType, message string, detail map[string]interface{}) {
	if h.config.EventAppender != nil {
		h.config.EventAppender.AppendEvent(h.config.WorkspaceID, level, eventType, message, detail)
	}
}

// fetchAgentKey retrieves the decrypted agent credential from the control plane.
func (h *SessionHost) fetchAgentKey(ctx context.Context, agentType string) (*agentCredential, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/agent-key", h.config.ControlPlaneURL, h.config.WorkspaceID)

	body, err := json.Marshal(map[string]string{"agentType": agentType})
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", url, byteReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+h.config.CallbackToken)

	resp, err := h.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch agent key: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("no credential configured for %s", agentType)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("control plane returned status %d", resp.StatusCode)
	}

	var result struct {
		APIKey          string           `json:"apiKey"`
		CredentialKind  string           `json:"credentialKind"`
		InferenceConfig *inferenceConfig `json:"inferenceConfig,omitempty"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	// Allow empty APIKey when inferenceConfig is present (platform AI proxy path).
	if result.APIKey == "" && result.InferenceConfig == nil {
		return nil, fmt.Errorf("empty credential returned for %s", agentType)
	}

	if result.CredentialKind == "" {
		result.CredentialKind = "api-key"
	}

	return &agentCredential{
		credential:      result.APIKey,
		credentialKind:  result.CredentialKind,
		inferenceConfig: result.InferenceConfig,
	}, nil
}

// fetchAgentSettings retrieves user's agent settings from the control plane.
func (h *SessionHost) fetchAgentSettings(ctx context.Context, agentType string) *agentSettingsPayload {
	url := fmt.Sprintf("%s/api/workspaces/%s/agent-settings", h.config.ControlPlaneURL, h.config.WorkspaceID)

	body, err := json.Marshal(map[string]string{"agentType": agentType})
	if err != nil {
		slog.Warn("Failed to marshal agent settings request", "error", err)
		return nil
	}

	req, err := http.NewRequestWithContext(ctx, "POST", url, byteReader(body))
	if err != nil {
		slog.Warn("Failed to create agent settings request", "error", err)
		return nil
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+h.config.CallbackToken)

	resp, err := h.httpClient().Do(req)
	if err != nil {
		slog.Warn("Failed to fetch agent settings", "error", err)
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		slog.Warn("Agent settings returned non-OK status, using defaults",
			"statusCode", resp.StatusCode,
			"responseBody", string(respBody),
			"url", url,
			"workspaceId", h.config.WorkspaceID,
			"agentType", agentType)
		return nil
	}

	var result agentSettingsPayload
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		slog.Warn("Failed to decode agent settings", "error", err)
		return nil
	}

	slog.Info("Fetched agent settings from control plane",
		"model", result.Model,
		"permissionMode", result.PermissionMode,
		"opencodeProvider", result.OpencodeProvider,
		"opencodeBaseURL", result.OpencodeBaseURL,
		"workspaceId", h.config.WorkspaceID,
		"agentType", agentType)
	return &result
}

// activityPayload is the enhanced JSON body sent to the control plane.
type activityPayload struct {
	Activity        string  `json:"activity"`
	NodeID          string  `json:"nodeId"`
	PromptStartedAt *int64  `json:"promptStartedAt,omitempty"`
	AgentType       string  `json:"agentType,omitempty"`
	RestartCount    int     `json:"restartCount"`
	StatusError     *string `json:"statusError,omitempty"`
}

// reportActivity sends a durable activity signal to the control plane.
// Prompting reports stay cheap because the periodic re-report loop self-heals
// missed starts; terminal/error reports use a larger retry budget.
// activity should be "prompting", "idle", "recovering", or "error".
func (h *SessionHost) reportActivity(activity string) {
	// h.config fields are immutable after construction — no lock needed.
	projectID := h.config.ProjectID
	nodeID := h.config.NodeID
	controlPlaneURL := h.config.ControlPlaneURL
	callbackToken := h.config.CallbackToken
	sessionID := h.config.SessionID

	if projectID == "" || nodeID == "" || controlPlaneURL == "" || sessionID == "" {
		slog.Debug("reportActivity: skipping, missing config",
			"hasProjectID", projectID != "",
			"hasNodeID", nodeID != "",
			"hasControlPlaneURL", controlPlaneURL != "",
			"hasSessionID", sessionID != "")
		return
	}

	// Snapshot state under read lock for the enhanced payload.
	h.mu.RLock()
	agentType := h.agentType
	restartCount := h.restartCount
	statusErr := h.statusErr
	h.mu.RUnlock()

	payload := activityPayload{
		Activity:     activity,
		NodeID:       nodeID,
		AgentType:    agentType,
		RestartCount: restartCount,
	}
	if activity == "prompting" {
		now := time.Now().UnixMilli()
		payload.PromptStartedAt = &now
	}
	// Attach a redacted status error for prompting/error states so the control
	// plane can persist a useful failure reason without leaking credentials.
	if statusErr != "" && (activity == "prompting" || activity == "error") {
		redactedStatusErr := truncateString(redactAgentDiagnosticText(statusErr), 2048)
		payload.StatusError = &redactedStatusErr
	}

	go func() {
		url := strings.TrimRight(controlPlaneURL, "/") +
			"/api/projects/" + projectID + "/acp-sessions/" + sessionID + "/activity"

		body, err := json.Marshal(payload)
		if err != nil {
			slog.Warn("reportActivity: marshal failed", "error", err)
			return
		}

		maxAttempts, retryBackoff := h.activityReportRetryPolicy(activity)
		for attempt := 1; attempt <= maxAttempts; attempt++ {
			statusCode, doErr := h.doActivityRequest(url, body, callbackToken)
			if doErr != nil {
				if attempt < maxAttempts {
					slog.Info("reportActivity: attempt failed, retrying", "attempt", attempt, "error", doErr)
					time.Sleep(retryBackoff)
					continue
				}
				slog.Warn("reportActivity: all attempts failed", "error", doErr)
				return
			}
			if statusCode >= 500 && attempt < maxAttempts {
				slog.Info("reportActivity: server error, retrying", "status", statusCode)
				time.Sleep(retryBackoff)
				continue
			}
			if statusCode >= 400 {
				slog.Warn("reportActivity: non-2xx response", "status", statusCode)
			}
			return
		}
	}()
}

func (h *SessionHost) activityReportRetryPolicy(activity string) (int, time.Duration) {
	if activity == "prompting" {
		return 2, 500 * time.Millisecond
	}
	attempts := h.config.TerminalActivityReportAttempts
	if attempts <= 0 {
		attempts = 2
	}
	backoff := h.config.TerminalActivityReportBackoff
	if backoff <= 0 {
		backoff = 500 * time.Millisecond
	}
	return attempts, backoff
}

// doActivityRequest performs a single HTTP POST attempt to the activity endpoint.
// Returns the HTTP status code on success, or an error on network/request failure.
func (h *SessionHost) doActivityRequest(url string, body []byte, callbackToken string) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// bytes.NewReader is created fresh each call so the body is correctly
	// re-read on retry without needing to seek.
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+callbackToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := h.httpClient().Do(req)
	if err != nil {
		return 0, err
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	resp.Body.Close()

	return resp.StatusCode, nil
}
