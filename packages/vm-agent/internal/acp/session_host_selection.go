package acp

import (
	"context"
	"fmt"
	"log/slog"
)

// SelectAgent handles agent selection requests from a browser.
// It fetches credentials, installs the binary, starts the process,
// and initializes the ACP session.
func (h *SessionHost) SelectAgent(ctx context.Context, agentType string) {
	_ = h.selectAgent(ctx, agentType, false)
}

// RestoreAgent restores an exact prior ACP session. Unlike normal interactive
// selection, it never falls back to NewSession when LoadSession is unavailable
// or fails, because that would silently present a fork as a true resume.
func (h *SessionHost) RestoreAgent(ctx context.Context, agentType string) error {
	return h.selectAgent(ctx, agentType, true)
}

func (h *SessionHost) selectAgent(ctx context.Context, agentType string, requireLoadSession bool) error {
	previous, started := h.beginAgentSelection(agentType)
	if !started {
		return nil
	}
	// Release the in-progress guard once the selection resolves (success or
	// failure), so a later legitimate selection is not blocked as a duplicate.
	defer h.finishAgentSelection()

	h.broadcastAgentStatus(StatusStarting, agentType, "")
	h.reportLifecycle("info", "Agent selection started", map[string]interface{}{
		"agentType":            agentType,
		"previousAcpSessionID": previous.acpSessionID,
		"previousAgentType":    previous.agentType,
		"sessionId":            h.config.SessionID,
	})
	loadSessionID := h.resolveLoadSessionID(agentType, previous)
	if requireLoadSession && loadSessionID == "" {
		err := fmt.Errorf("restore requires a previous ACP session for the same agent type")
		h.failAgentSelection(agentType, "agent_restore", "Saved agent context is unavailable", err)
		return err
	}

	cred, err := h.fetchAgentKey(ctx, agentType)
	if err != nil {
		h.failAgentSelection(agentType, "agent_key_fetch", fmt.Sprintf("Failed to fetch credential for %s — check Settings", agentType), err)
		return err
	}
	h.reportCredentialFetched(agentType, cred)

	info := getAgentCommandInfo(agentType, cred.credentialKind)
	if err := h.ensureAgentInstalled(ctx, info); err != nil {
		h.failAgentSelection(agentType, "agent_install", fmt.Sprintf("Failed to install %s: %v", info.command, err), err)
		return err
	}
	h.reportLifecycle("info", "Agent binary verified/installed", map[string]interface{}{
		"agentType": agentType,
		"command":   info.command,
	})

	settings := h.loadAgentSettings(ctx, agentType)
	if err := h.startSelectedAgent(ctx, agentType, cred, settings, loadSessionID, requireLoadSession); err != nil {
		return err
	}
	// Only now that the ACP session is established do we consume the one-shot
	// reconnect/restore identity. A transient failure above leaves it intact so a
	// retry on the cached SessionHost can still LoadSession-resume (rule 49).
	h.consumePreviousSelectionOnSuccess()

	h.reportLifecycle("info", "Agent ready", map[string]interface{}{
		"agentType": agentType,
		"sessionId": h.config.SessionID,
	})
	h.reportEvent("info", "agent.ready", fmt.Sprintf("Agent %s is ready", agentType), map[string]interface{}{
		"agentType": agentType,
	})
	h.broadcastAgentStatus(StatusReady, agentType, "")
	return nil
}

type previousAgentSelection struct {
	acpSessionID string
	agentType    string
}

func (h *SessionHost) beginAgentSelection(agentType string) (previousAgentSelection, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()

	slog.Info("SessionHost: agent selection requested", "sessionID", h.config.SessionID, "agentType", agentType)
	if h.agentType == agentType && h.process != nil && (h.status == HostReady || h.status == HostStarting) {
		slog.Info("SessionHost: agent already running/starting with requested type, skipping restart",
			"sessionID", h.config.SessionID, "agentType", agentType, "status", h.status)
		return previousAgentSelection{}, false
	}
	if h.selectionInProgress && h.agentType == agentType {
		// A concurrent selection for the same agent is mid-flight. Its
		// credential-fetch/install runs outside h.mu, so h.process is still nil
		// and the guard above does not catch it. Treat this as an idempotent
		// duplicate rather than spawning a second process for one session.
		slog.Info("SessionHost: agent selection already in progress, skipping duplicate",
			"sessionID", h.config.SessionID, "agentType", agentType, "status", h.status)
		return previousAgentSelection{}, false
	}

	previous := h.capturePreviousAgentSelection()
	if h.process != nil {
		h.stopCurrentAgentLocked()
	}
	h.agentType = agentType
	h.status = HostStarting
	h.statusErr = ""
	h.selectionInProgress = true
	h.resetStderrBuffer()
	return previous, true
}

// capturePreviousAgentSelection reads the reconnect/restore identity to attempt
// LoadSession with. It intentionally does NOT clear h.config.Previous* — that is
// deferred to consumePreviousSelectionOnSuccess so a transient failure before
// establishACPSession leaves the identity intact for a retry (rule 49). Must
// hold h.mu.
func (h *SessionHost) capturePreviousAgentSelection() previousAgentSelection {
	previous := previousAgentSelection{agentType: h.agentType}
	if h.sessionID != "" {
		previous.acpSessionID = string(h.sessionID)
	}
	if previous.acpSessionID == "" && h.config.PreviousAcpSessionID != "" {
		previous.acpSessionID = h.config.PreviousAcpSessionID
	}
	if previous.agentType == "" && h.config.PreviousAgentType != "" {
		previous.agentType = h.config.PreviousAgentType
	}
	return previous
}

// finishAgentSelection releases the in-progress guard set by beginAgentSelection.
func (h *SessionHost) finishAgentSelection() {
	h.mu.Lock()
	h.selectionInProgress = false
	h.mu.Unlock()
}

// consumePreviousSelectionOnSuccess clears the one-shot reconnect/restore
// identity after a selection fully succeeds. Clearing is deferred to here (not
// capture time) so a transient pre-establishACPSession failure does not
// permanently strip the restore identity from a cached SessionHost — a retry
// must still be able to LoadSession-resume (rule 49).
func (h *SessionHost) consumePreviousSelectionOnSuccess() {
	h.mu.Lock()
	h.config.PreviousAcpSessionID = ""
	h.config.PreviousAgentType = ""
	h.mu.Unlock()
}

func (h *SessionHost) resetStderrBuffer() {
	h.stderrMu.Lock()
	h.stderrBuf.Reset()
	h.stderrMu.Unlock()
}

func (h *SessionHost) failAgentSelection(agentType, source, message string, err error) {
	slog.Error("Agent selection failed", "source", source, "error", err)
	h.setStatus(HostError, message)
	h.broadcastAgentStatus(StatusError, agentType, message)
	detail := ""
	if err != nil {
		detail = err.Error()
	}
	h.reportAgentError(agentType, source, message, detail)
	h.persistAgentSelectionFailure(agentType, message)
	h.reportActivity("error")
}

func (h *SessionHost) reportCredentialFetched(agentType string, cred *agentCredential) {
	hasInferenceConfig := cred.inferenceConfig != nil
	inferenceModel, inferenceBaseURL, inferenceAPIKeySource := "", "", ""
	if hasInferenceConfig {
		inferenceModel = cred.inferenceConfig.Model
		inferenceBaseURL = cred.inferenceConfig.BaseURL
		inferenceAPIKeySource = cred.inferenceConfig.APIKeySource
	}
	context := map[string]interface{}{
		"agentType":             agentType,
		"credentialKind":        cred.credentialKind,
		"hasInferenceConfig":    hasInferenceConfig,
		"inferenceModel":        inferenceModel,
		"inferenceBaseURL":      inferenceBaseURL,
		"inferenceAPIKeySource": inferenceAPIKeySource,
	}
	h.reportLifecycle("info", "Agent credential fetched", context)
	slog.Debug("Agent credential details",
		"agentType", agentType, "credentialKind", cred.credentialKind,
		"hasInferenceConfig", hasInferenceConfig, "inferenceModel", inferenceModel,
		"inferenceBaseURL", inferenceBaseURL, "inferenceAPIKeySource", inferenceAPIKeySource,
		"credentialLen", len(cred.credential), "workspaceId", h.config.WorkspaceID)
}

func (h *SessionHost) loadAgentSettings(ctx context.Context, agentType string) *agentSettingsPayload {
	settings := h.fetchAgentSettings(ctx, agentType)
	if settings == nil {
		slog.Info("No agent settings found, using defaults", "agentType", agentType, "workspaceId", h.config.WorkspaceID)
		return h.applyProfileOverrides(nil)
	}
	slog.Info("Agent settings loaded",
		"model", settings.Model, "permissionMode", settings.PermissionMode, "effort", settings.Effort,
		"opencodeProvider", settings.OpencodeProvider, "opencodeBaseURL", settings.OpencodeBaseURL,
		"agentType", agentType, "workspaceId", h.config.WorkspaceID)
	return h.applyProfileOverrides(settings)
}

func (h *SessionHost) applyProfileOverrides(settings *agentSettingsPayload) *agentSettingsPayload {
	if h.config.ModelOverride == "" && h.config.PermissionModeOverride == "" &&
		h.config.EffortOverride == "" && h.config.OpencodeProviderOverride == "" && h.config.OpencodeBaseURLOverride == "" {
		return settings
	}
	if settings == nil {
		settings = &agentSettingsPayload{}
	}
	if h.config.ModelOverride != "" {
		settings.Model = h.config.ModelOverride
		slog.Info("Agent model overridden by profile", "model", h.config.ModelOverride)
	}
	if h.config.PermissionModeOverride != "" {
		settings.PermissionMode = h.config.PermissionModeOverride
		slog.Info("Agent permission mode overridden by profile", "permissionMode", h.config.PermissionModeOverride)
	}
	if h.config.EffortOverride != "" {
		settings.Effort = h.config.EffortOverride
		slog.Info("Agent effort overridden by profile", "effort", h.config.EffortOverride)
	}
	if h.config.OpencodeProviderOverride != "" {
		settings.OpencodeProvider = h.config.OpencodeProviderOverride
		slog.Info("OpenCode provider overridden by profile", "provider", h.config.OpencodeProviderOverride)
	}
	if h.config.OpencodeBaseURLOverride != "" {
		settings.OpencodeBaseURL = h.config.OpencodeBaseURLOverride
		slog.Info("OpenCode base URL overridden by profile", "baseUrl", h.config.OpencodeBaseURLOverride)
	}
	return settings
}

func (h *SessionHost) resolveLoadSessionID(agentType string, previous previousAgentSelection) string {
	if previous.acpSessionID == "" {
		return ""
	}
	if previous.agentType == agentType {
		slog.Info("ACP: will attempt LoadSession", "sessionID", previous.acpSessionID)
		h.reportLifecycle("info", "LoadSession will be attempted", map[string]interface{}{
			"agentType":            agentType,
			"previousAcpSessionID": previous.acpSessionID,
		})
		return previous.acpSessionID
	}
	slog.Info("ACP: skipping LoadSession, agent type mismatch", "previousAgentType", previous.agentType, "requestedAgentType", agentType)
	h.reportLifecycle("info", "LoadSession skipped: agent type mismatch", map[string]interface{}{
		"previousAgentType": previous.agentType,
		"requestedAgent":    agentType,
	})
	return ""
}

func (h *SessionHost) startSelectedAgent(ctx context.Context, agentType string, cred *agentCredential, settings *agentSettingsPayload, loadSessionID string, requireLoadSession bool) error {
	h.mu.Lock()
	var err error
	if requireLoadSession {
		err = h.startAgentForCrashRecovery(ctx, agentType, cred, settings, loadSessionID)
	} else {
		err = h.startAgent(ctx, agentType, cred, settings, loadSessionID)
	}
	if err != nil {
		message := err.Error()
		// establishACPSession can fail AFTER the agent process spawned (e.g.
		// LoadSession rejected while the process is still alive). Stop it here so
		// a failed restore/selection does not leak an orphaned agent binary.
		// stopCurrentAgentLocked clears h.process, so the already-running
		// monitorProcessExit goroutine sees a replaced process and skips restart
		// once it re-acquires h.mu.
		h.stopCurrentAgentLocked()
		h.status = HostError
		h.statusErr = message
		h.mu.Unlock()
		slog.Error("Agent start failed", "error", err)
		h.broadcastAgentStatus(StatusError, agentType, message)
		h.reportAgentError(agentType, "agent_start", message, "")
		h.persistAgentSelectionFailure(agentType, message)
		h.reportActivity("error")
		return err
	}
	h.status = HostReady
	h.statusErr = ""
	h.mu.Unlock()
	return nil
}
