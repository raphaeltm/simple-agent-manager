package acp

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// phaseTimeout returns a per-phase timeout duration. If phaseMs is > 0, it is
// used; otherwise the fallback timeout is returned.
func phaseTimeout(phaseMs int, fallback time.Duration) time.Duration {
	if phaseMs > 0 {
		return time.Duration(phaseMs) * time.Millisecond
	}
	return fallback
}

// applySessionSettings calls SetSessionConfigOption for the model and
// SetSessionMode on the ACP connection. A rejected explicit Codex model is fatal:
// continuing would silently run a different model. Other adapter settings remain
// best-effort for backward compatibility.
func (h *SessionHost) applySessionSettings(ctx context.Context, settings *agentSettingsPayload) error {
	if settings == nil || h.acpConn == nil || h.sessionID == "" {
		return nil
	}

	// These RPCs run while h.mu is held for write, and the ACP SDK blocks each
	// response on its notification worker catching up (waitNotificationsUpTo).
	// The caller's ctx is the WebSocket connection lifetime — effectively
	// unbounded — so a stalled notification worker would hang the handshake (and
	// every h.mu reader) forever. Bound it explicitly; Codex model selection
	// failures are returned while the remaining settings stay best-effort.
	settingsCtx, cancel := context.WithTimeout(ctx, h.sessionSettingsTimeout())
	defer cancel()
	ctx = settingsCtx

	if settings.Model != "" {
		if err := h.applySessionModelConfigOption(ctx, settings.Model); err != nil && h.agentType == "openai-codex" {
			return fmt.Errorf("cannot apply requested Codex model %q: %w", settings.Model, err)
		}
	}

	if settings.PermissionMode != "" && settings.PermissionMode != "default" {
		// Codex (openai-codex) does not support SetSessionMode — skip to avoid
		// a guaranteed error on every session start.
		if h.agentType == "openai-codex" {
			slog.Info("ACP: skipping SetSessionMode for openai-codex (unsupported)", "mode", settings.PermissionMode)
		} else {
			slog.Info("ACP: setting session mode", "mode", settings.PermissionMode)
			if _, err := h.acpConn.SetSessionMode(ctx, acpsdk.SetSessionModeRequest{
				SessionId: h.sessionID,
				ModeId:    acpsdk.SessionModeId(settings.PermissionMode),
			}); err != nil {
				slog.Warn("ACP SetSessionMode failed (non-fatal)", "mode", settings.PermissionMode, "error", err)
				h.reportLifecycle("warn", "ACP SetSessionMode failed", map[string]interface{}{
					"mode":  settings.PermissionMode,
					"error": err.Error(),
				})
			} else {
				slog.Info("ACP: session mode set", "mode", settings.PermissionMode)
				h.reportLifecycle("info", "ACP session mode applied", map[string]interface{}{
					"mode": settings.PermissionMode,
				})
			}
		}
	}
	return nil
}

func (h *SessionHost) applySessionModelConfigOption(ctx context.Context, model string) error {
	modelConfigID, ok := findModelConfigOptionID(h.configOptions)
	if !ok {
		slog.Warn("ACP session model config option unavailable", "model", model)
		h.reportLifecycle("warn", "ACP session model config option unavailable", map[string]interface{}{
			"model": model,
		})
		return fmt.Errorf("model config option unavailable")
	}

	slog.Info("ACP: setting session model config option", "model", model, "configId", string(modelConfigID))
	resp, err := h.acpConn.SetSessionConfigOption(ctx, acpsdk.SetSessionConfigOptionRequest{
		ValueId: &acpsdk.SetSessionConfigOptionValueId{
			SessionId: h.sessionID,
			ConfigId:  modelConfigID,
			Value:     acpsdk.SessionConfigValueId(model),
		},
	})
	if err != nil {
		slog.Warn("ACP SetSessionConfigOption failed", "model", model, "configId", string(modelConfigID), "error", err)
		h.reportLifecycle("warn", "ACP session model config option failed", map[string]interface{}{
			"model":    model,
			"configId": string(modelConfigID),
			"error":    err.Error(),
		})
		return fmt.Errorf("set session model config option: %w", err)
	}

	h.configOptions = resp.ConfigOptions
	slog.Info("ACP: session model config option set", "model", model, "configId", string(modelConfigID))
	h.reportLifecycle("info", "ACP session model applied", map[string]interface{}{
		"model":    model,
		"configId": string(modelConfigID),
	})
	return nil
}

func findModelConfigOptionID(options []acpsdk.SessionConfigOption) (acpsdk.SessionConfigId, bool) {
	for _, option := range options {
		if option.Select == nil || option.Select.Category == nil {
			continue
		}
		if *option.Select.Category == acpsdk.SessionConfigOptionCategoryModel {
			return option.Select.Id, true
		}
	}
	return "", false
}

// DefaultSessionSettingsTimeout bounds the post-handshake SetSessionMode /
// SetSessionConfigOption RPCs. Override via the existing NewSessionTimeoutMs
// gateway setting (ACP_NEW_SESSION_TIMEOUT_MS).
const DefaultSessionSettingsTimeout = 30 * time.Second

// sessionSettingsTimeout resolves the bound for applySessionSettings' RPCs,
// reusing the configured NewSession timeout when one is set.
func (h *SessionHost) sessionSettingsTimeout() time.Duration {
	if h.config.NewSessionTimeoutMs > 0 {
		return time.Duration(h.config.NewSessionTimeoutMs) * time.Millisecond
	}
	return DefaultSessionSettingsTimeout
}
