package server

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/workspace/vm-agent/internal/acp"
)

func (s *Server) handleRestoreAgentSession(w http.ResponseWriter, r *http.Request) {
	input, ok := s.sessionSnapshotHandlerInput(w, r, true)
	if !ok {
		return
	}
	result, err := s.runSessionRestore(r.Context(), input, func(ctx context.Context) map[string]interface{} {
		result, restoreErr := s.restoreSessionSnapshot(ctx, input.runtime, input.sessionID, input.chatSessionID, input.agentType, input.callbackToken)
		if restoreErr != nil {
			_ = s.reportSnapshotRestoreResult(context.Background(), input.workspaceID, input.chatSessionID, "degraded", restoreErr.Error(), input.callbackToken)
			s.prepareFreshSessionAfterDegradedRestore(input.workspaceID, input.sessionID, restoreErr)
			return map[string]interface{}{"status": "degraded", "message": "The saved workspace was restored, but the agent context could not be resumed."}
		}
		return result
	})
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) prepareFreshSessionAfterDegradedRestore(workspaceID, sessionID string, restoreErr error) {
	hostKey := workspaceID + ":" + sessionID
	s.sessionHostMu.Lock()
	host := s.sessionHosts[hostKey]
	if host != nil {
		delete(s.sessionHosts, hostKey)
	}
	s.sessionHostMu.Unlock()
	if host != nil {
		host.Stop()
	}

	if _, err := s.agentSessions.PrepareDegradedRestoreFallback(workspaceID, sessionID); err != nil {
		slog.Warn("Failed to prepare agent session for degraded snapshot fresh fallback",
			"workspace", workspaceID, "session", sessionID, "error", err)
	}
	if s.store != nil {
		if err := s.store.UpdateTabAcpSessionID(sessionID, ""); err != nil {
			slog.Warn("Failed to clear persisted tab ACP session identity after degraded snapshot restore",
				"workspace", workspaceID, "session", sessionID, "error", err)
		}
	}
	s.appendNodeEvent(workspaceID, "warn", "session_snapshot.restore_degraded_fresh_fallback", "Snapshot restore degraded; next start will create a fresh agent context", map[string]interface{}{
		"sessionId": sessionID,
		"error":     restoreErr.Error(),
	})
}

func (s *Server) restoreSessionSnapshot(ctx context.Context, runtime *WorkspaceRuntime, sessionID, chatSessionID, agentType, callbackToken string) (map[string]interface{}, error) {
	restore, err := s.fetchSnapshotRestore(ctx, runtime.ID, chatSessionID, callbackToken)
	if err != nil {
		return nil, err
	}
	if !restore.Available {
		_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "missing", restore.Reason, callbackToken)
		return map[string]interface{}{"status": "transcript-replay", "reason": restore.Reason}, nil
	}
	gitState, err := snapshotRestoreGitState(restore)
	if err != nil {
		_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "git_failed", err.Error(), callbackToken)
		return nil, err
	}
	idleTimeout := choosePositiveDurationMs(restore.Config.TransferIdleTimeoutMs, defaultSnapshotTransferIdleTimeout)
	totalBudget := choosePositiveInt64(restore.Config.TotalBudgetBytes, defaultSnapshotTotalBudgetBytes)
	entryThreshold := choosePositiveInt64(restore.Config.EntryThresholdBytes, defaultSnapshotEntryThresholdBytes)
	// A freshly launched VM has no devcontainer to restore into. Provision the
	// repository and container first; credential-bearing HOME paths are excluded
	// from snapshots, so fresh control-plane credential injection remains
	// authoritative even though the safe HOME archive is applied afterward.
	var provisionErr error
	if s.config.IsStandaloneMode() {
		provisionErr = s.prepareStandaloneWorkspaceRuntime(ctx, runtime)
	} else {
		_, provisionErr = s.provisionWorkspaceRuntime(ctx, runtime)
	}
	if provisionErr != nil {
		_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "fresh_injection_failed", provisionErr.Error(), callbackToken)
		return nil, provisionErr
	}
	var validateRestoredGitState func() error
	if s.config.IsStandaloneMode() && restore.Download.Home != "" {
		if err := s.downloadAndExtractSessionStateTar(ctx, restore.Download.Home, callbackToken, idleTimeout, entryThreshold, totalBudget); err != nil {
			_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "home_failed", err.Error(), callbackToken)
			return nil, err
		}
	}
	if s.config.IsStandaloneMode() && restore.Download.WIP == "" {
		workDir := standaloneWorkspaceWorkDir(runtime, s.config.WorkspaceDir, s.config.ContainerWorkDir)
		if err := restoreStandaloneSnapshotGitState(ctx, workDir, gitState); err != nil {
			_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "git_failed", err.Error(), callbackToken)
			return nil, err
		}
	}
	if s.config.IsStandaloneMode() && restore.Download.WIP != "" {
		workDir := standaloneWorkspaceWorkDir(runtime, s.config.WorkspaceDir, s.config.ContainerWorkDir)
		if err := s.downloadAndRestoreWIPWithGitState(ctx, restore.Download.WIP, callbackToken, idleTimeout, workDir, gitState); err != nil {
			_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "wip_failed", err.Error(), callbackToken)
			return nil, err
		}
	}
	if s.config.IsStandaloneMode() {
		workDir := standaloneWorkspaceWorkDir(runtime, s.config.WorkspaceDir, s.config.ContainerWorkDir)
		validateRestoredGitState = func() error {
			return validateStandaloneSnapshotGitState(ctx, workDir, gitState)
		}
		if err := validateStandaloneSnapshotGitState(ctx, workDir, gitState); err != nil {
			_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "git_mismatch", err.Error(), callbackToken)
			return nil, err
		}
	}
	if !s.config.IsStandaloneMode() {
		target, targetErr := s.resolveContainerSnapshotTarget(ctx, runtime)
		if targetErr != nil {
			return nil, targetErr
		}
		if restore.Download.Home != "" {
			if err := s.downloadAndExtractContainerHome(ctx, target, restore.Download.Home, callbackToken, idleTimeout, entryThreshold, totalBudget); err != nil {
				_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "home_failed", err.Error(), callbackToken)
				return nil, err
			}
		}
		gitCommand := func(ctx context.Context, env []string, args ...string) (string, error) {
			return s.containerGit(ctx, target, env, args...)
		}
		validateRestoredGitState = func() error {
			return validateSnapshotGitState(ctx, gitCommand, gitState)
		}
		if restore.Download.WIP == "" {
			if err := restoreSnapshotGitState(ctx, gitCommand, gitState); err != nil {
				_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "git_failed", err.Error(), callbackToken)
				return nil, err
			}
		} else {
			if err := s.downloadAndRestoreContainerWIPWithGitState(ctx, target, restore.Download.WIP, callbackToken, idleTimeout, totalBudget, gitState); err != nil {
				_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "wip_failed", err.Error(), callbackToken)
				return nil, err
			}
		}
		if err := validateSnapshotGitState(ctx, gitCommand, gitState); err != nil {
			_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "git_mismatch", err.Error(), callbackToken)
			return nil, err
		}
	}

	acpSessionID, savedAgentType, identityErr := snapshotHarnessResumeIdentity(restore.Manifest, sessionID, agentType)
	if identityErr != nil {
		return nil, identityErr
	}
	// Prime the per-workspace message reporter before the agent starts.
	s.primeRestoredMessageReporter(runtime, chatSessionID)
	if _, _, createErr := s.agentSessions.Create(runtime.ID, sessionID, "Restored session", "restore:"+sessionID); createErr != nil {
		if _, exists := s.agentSessions.Get(runtime.ID, sessionID); !exists {
			return nil, fmt.Errorf("recreate restored agent session: %w", createErr)
		}
	}
	if updateErr := s.agentSessions.UpdateAcpSessionID(runtime.ID, sessionID, acpSessionID, savedAgentType); updateErr != nil {
		return nil, fmt.Errorf("hydrate restored agent session: %w", updateErr)
	}
	session, exists := s.agentSessions.Get(runtime.ID, sessionID)
	if !exists {
		return nil, fmt.Errorf("restored agent session is unavailable")
	}
	hostKey := runtime.ID + ":" + sessionID
	host := s.getOrCreateSessionHostForRestore(hostKey, runtime.ID, sessionID, session, runtime, "", true)
	if restoreErr := host.RestoreAgent(ctx, savedAgentType); restoreErr != nil {
		return nil, fmt.Errorf("resume saved agent context: %w", restoreErr)
	}
	if host.Status() != acp.HostReady {
		return nil, fmt.Errorf("restored agent failed to become ready: %s", host.Status())
	}
	if err := s.reportRestoredSnapshotIfGitStateMatches(ctx, runtime.ID, chatSessionID, callbackToken, validateRestoredGitState); err != nil {
		return nil, err
	}
	return map[string]interface{}{"status": "restored", "degradation": restore.Degradation}, nil
}

func (s *Server) reportRestoredSnapshotIfGitStateMatches(ctx context.Context, workspaceID, chatSessionID, callbackToken string, validateGitState func() error) error {
	if validateGitState != nil {
		if err := validateGitState(); err != nil {
			_ = s.reportSnapshotRestoreResult(ctx, workspaceID, chatSessionID, "git_mismatch", err.Error(), callbackToken)
			return err
		}
	}
	_ = s.reportSnapshotRestoreResult(ctx, workspaceID, chatSessionID, "restored", "", callbackToken)
	return nil
}

func snapshotRestoreGitState(restore *snapshotRestoreResponse) (snapshotGitState, error) {
	state := snapshotGitState{BaseCommit: strings.TrimSpace(restore.BaseCommit)}
	if restore.Manifest == nil {
		return state, nil
	}
	manifestCommit := strings.TrimSpace(restore.Manifest.BaseCommit)
	if state.BaseCommit == "" {
		state.BaseCommit = manifestCommit
	} else if manifestCommit != "" && manifestCommit != state.BaseCommit {
		return snapshotGitState{}, fmt.Errorf("snapshot Git metadata mismatch: response BaseCommit %s differs from manifest BaseCommit %s", state.BaseCommit, manifestCommit)
	}
	state.Git = restore.Manifest.Git
	if state.Git != nil && state.BaseCommit == "" {
		return snapshotGitState{}, fmt.Errorf("snapshot Git metadata is present without a saved BaseCommit")
	}
	return state, nil
}

func snapshotHarnessResumeIdentity(manifest *snapshotManifest, sessionID, requestedAgentType string) (string, string, error) {
	if manifest == nil {
		return "", "", fmt.Errorf("snapshot manifest is unavailable")
	}
	if manifest.Artifacts == nil {
		return "", "", fmt.Errorf("snapshot does not contain restored home state")
	}
	if _, ok := manifest.Artifacts["home"]; !ok {
		return "", "", fmt.Errorf("snapshot does not contain restored home state")
	}
	// AgentSessionID is the old control-plane routing identity. A VM wake creates
	// a replacement routing row, while AcpSessionID remains the authoritative
	// harness identity that must be loaded. Chat/workspace ownership is validated
	// by the authenticated snapshot endpoints before this point.
	acpSessionID := strings.TrimSpace(manifest.AcpSessionID)
	savedAgentType := strings.TrimSpace(manifest.AgentType)
	if acpSessionID == "" || savedAgentType == "" {
		return "", "", fmt.Errorf("snapshot does not contain resumable agent context")
	}
	requestedAgentType = strings.TrimSpace(requestedAgentType)
	if requestedAgentType == "" {
		return "", "", fmt.Errorf("agent type is required to restore a standalone session")
	}
	if requestedAgentType != savedAgentType {
		return "", "", fmt.Errorf("snapshot agent type does not match requested agent")
	}
	return acpSessionID, savedAgentType, nil
}

// primeRestoredMessageReporter ensures the per-workspace message reporter exists
// and is bound to the restored chat session before the agent starts producing
// output. handleCreateAgentSession does this on the normal path; the restore
// path must replicate it or the restored agent's replies are never enqueued and
// are silently dropped after a wake.
func (s *Server) primeRestoredMessageReporter(runtime *WorkspaceRuntime, chatSessionID string) {
	if runtime == nil {
		return
	}
	chatSessionID = strings.TrimSpace(chatSessionID)
	projectID := strings.TrimSpace(runtime.ProjectID)
	if projectID == "" {
		projectID = strings.TrimSpace(s.config.ProjectID)
	}
	if projectID == "" || chatSessionID == "" {
		// Without a project + chat session the reporter cannot be created, so
		// the restored agent's output would be silently dropped. Log loudly so
		// this failure mode is diagnosable instead of invisible.
		slog.Warn("Restored session message reporter not primed: missing project or chat session",
			"workspaceId", runtime.ID, "hasProjectID", projectID != "", "hasChatSessionID", chatSessionID != "")
		return
	}
	var updated *WorkspaceRuntime
	s.workspaceMu.Lock()
	if rt, ok := s.workspaces[runtime.ID]; ok {
		if strings.TrimSpace(rt.ProjectID) == "" {
			rt.ProjectID = projectID
		}
		if strings.TrimSpace(rt.ChatSessionID) == "" {
			rt.ChatSessionID = chatSessionID
		}
		rt.UpdatedAt = nowUTC()
		copy := *rt
		updated = &copy
	}
	s.workspaceMu.Unlock()
	if updated != nil && updated.Repository != "" {
		s.persistWorkspaceMetadata(updated)
	}
	if reporter := s.getOrCreateReporter(runtime.ID, projectID, chatSessionID); reporter != nil {
		reporter.SetSessionID(chatSessionID)
	}
}
