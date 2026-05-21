package acp

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/workspace/vm-agent/internal/sysinfo"
)

func (h *SessionHost) establishACPSession(ctx context.Context, agentType string, settings *agentSettingsPayload, previousAcpSessionID string) error {
	timeouts := h.acpPhaseTimeouts()
	initResp, err := h.initializeACP(ctx, agentType, timeouts.initialize)
	if err != nil {
		return err
	}
	if h.tryLoadPreviousACPSession(ctx, agentType, settings, previousAcpSessionID, initResp.AgentCapabilities.LoadSession, timeouts.loadSession) {
		return nil
	}
	return h.startNewACPSession(ctx, agentType, settings, timeouts.newSession)
}

type acpPhaseTimeouts struct {
	initialize  time.Duration
	loadSession time.Duration
	newSession  time.Duration
}

func (h *SessionHost) acpPhaseTimeouts() acpPhaseTimeouts {
	fallback := time.Duration(h.config.InitTimeoutMs) * time.Millisecond
	if fallback == 0 {
		fallback = DefaultACPInitTimeout
	}
	return acpPhaseTimeouts{
		initialize:  phaseTimeout(h.config.InitializeTimeoutMs, fallback),
		loadSession: phaseTimeout(h.config.LoadSessionTimeoutMs, fallback),
		newSession:  phaseTimeout(h.config.NewSessionTimeoutMs, fallback),
	}
}

func (h *SessionHost) initializeACP(ctx context.Context, agentType string, timeout time.Duration) (acpsdk.InitializeResponse, error) {
	initCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	slog.Info("ACP: sending Initialize request", "timeout", timeout)
	h.reportLifecycle("info", "ACP Initialize started", map[string]interface{}{"agentType": agentType})
	resp, err := h.acpConn.Initialize(initCtx, acpsdk.InitializeRequest{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
		ClientInfo: &acpsdk.Implementation{
			Name:    "sam",
			Version: sysinfo.Version,
		},
		ClientCapabilities: acpsdk.ClientCapabilities{
			Fs: acpsdk.FileSystemCapabilities{ReadTextFile: true, WriteTextFile: true},
		},
	})
	if err != nil {
		h.reportLifecycle("warn", "ACP Initialize failed", map[string]interface{}{
			"agentType": agentType,
			"error":     err.Error(),
		})
		return acpsdk.InitializeResponse{}, fmt.Errorf("ACP initialize failed: %w", err)
	}
	cancel()
	slog.Info("ACP: Initialize succeeded", "loadSession", resp.AgentCapabilities.LoadSession)
	h.reportLifecycle("info", "ACP Initialize succeeded", map[string]interface{}{
		"agentType":           agentType,
		"supportsLoadSession": resp.AgentCapabilities.LoadSession,
	})
	return resp, nil
}

func (h *SessionHost) tryLoadPreviousACPSession(
	ctx context.Context,
	agentType string,
	settings *agentSettingsPayload,
	previousAcpSessionID string,
	supportsLoadSession bool,
	timeout time.Duration,
) bool {
	if previousAcpSessionID == "" {
		return false
	}
	if !supportsLoadSession {
		slog.Info("ACP: agent does not support LoadSession, using NewSession instead")
		h.reportLifecycle("info", "Agent does not support LoadSession", map[string]interface{}{"agentType": agentType})
		return false
	}

	loadCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	slog.Info("ACP: attempting LoadSession with previous session", "previousAcpSessionID", previousAcpSessionID, "timeout", timeout)
	h.reportLifecycle("info", "ACP LoadSession started", map[string]interface{}{
		"agentType":            agentType,
		"previousAcpSessionID": previousAcpSessionID,
	})
	h.reportEvent("info", "agent.load_session", "Restoring previous conversation", map[string]interface{}{"previousAcpSessionID": previousAcpSessionID})
	_, loadErr := h.acpConn.LoadSession(loadCtx, acpsdk.LoadSessionRequest{
		SessionId:  acpsdk.SessionId(previousAcpSessionID),
		Cwd:        h.config.ContainerWorkDir,
		McpServers: buildAcpMcpServers(h.config.McpServers, agentType),
	})
	cancel()
	if loadErr != nil {
		slog.Warn("ACP: LoadSession failed, falling back to NewSession", "error", loadErr)
		h.reportLifecycle("warn", "ACP LoadSession failed, falling back to NewSession", map[string]interface{}{
			"agentType": agentType,
			"error":     loadErr.Error(),
		})
		h.reportEvent("warn", "agent.load_session_failed", "Could not restore conversation, starting fresh", map[string]interface{}{"error": loadErr.Error()})
		return false
	}

	h.sessionID = acpsdk.SessionId(previousAcpSessionID)
	slog.Info("ACP: LoadSession succeeded", "sessionID", previousAcpSessionID)
	h.reportLifecycle("info", "ACP LoadSession succeeded", map[string]interface{}{
		"agentType":    agentType,
		"acpSessionId": previousAcpSessionID,
	})
	h.reportEvent("info", "agent.load_session_ok", "Previous conversation restored", map[string]interface{}{"acpSessionId": previousAcpSessionID})
	h.persistAcpSessionID(agentType)
	h.applySessionSettings(ctx, settings)
	return true
}

func (h *SessionHost) startNewACPSession(ctx context.Context, agentType string, settings *agentSettingsPayload, timeout time.Duration) error {
	newCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	slog.Info("ACP: sending NewSession request", "timeout", timeout)
	h.reportLifecycle("info", "ACP NewSession started", map[string]interface{}{"agentType": agentType})
	sessResp, err := h.acpConn.NewSession(newCtx, acpsdk.NewSessionRequest{
		Cwd:        h.config.ContainerWorkDir,
		McpServers: buildAcpMcpServers(h.config.McpServers, agentType),
	})
	if err != nil {
		h.reportLifecycle("warn", "ACP NewSession failed", map[string]interface{}{
			"agentType": agentType,
			"error":     err.Error(),
		})
		return fmt.Errorf("ACP new session failed: %w", err)
	}
	cancel()
	h.sessionID = sessResp.SessionId
	slog.Info("ACP: NewSession succeeded", "sessionID", string(h.sessionID))
	h.reportLifecycle("info", "ACP NewSession succeeded", map[string]interface{}{
		"agentType":    agentType,
		"acpSessionId": string(h.sessionID),
	})
	h.persistAcpSessionID(agentType)
	h.applySessionSettings(ctx, settings)

	return nil
}
