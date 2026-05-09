package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
)

// reportAgentError sends an agent error to boot-log and error reporter.
func (h *SessionHost) reportAgentError(agentType, step, message, detail string) {
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
