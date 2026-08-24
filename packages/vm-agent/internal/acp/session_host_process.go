package acp

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// monitorProcessExit detects agent crashes and attempts restart.
func (h *SessionHost) monitorProcessExit(ctx context.Context, process agentProcess, agentType string, cred *agentCredential, settings *agentSettingsPayload) {
	err := process.Wait()

	time.Sleep(100 * time.Millisecond)
	stderrOutput := redactAgentDiagnosticText(h.getAndClearStderr())
	uptime := time.Since(process.StartedAt())
	exitInfo := agentExitInfo(err)
	slog.Info("Agent process exited", "agentType", agentType, "uptime", uptime.Round(time.Millisecond), "exitInfo", exitInfo, "stderrBytes", len(stderrOutput))

	isRapidExit := uptime < 5*time.Second
	h.mu.Lock()
	if h.process != process {
		h.mu.Unlock()
		slog.Info("Agent process monitor: process replaced, skipping status/restart")
		return
	}
	intentionalPromptCancel := h.intentionalPromptCancelProcessStop
	h.intentionalPromptCancelProcessStop = false
	rollover := h.checkpointRollover
	rolloverForced := false
	if rollover != nil {
		rolloverForced = rollover.forced
	}
	previousAcpSessionID := string(h.sessionID)
	crashRecovery := h.crashRecoverySnapshotLocked()
	recoveryNotify := process.RecoveryNotify()
	h.mu.Unlock()

	if isRapidExit && !intentionalPromptCancel && rollover == nil {
		errMsg := rapidExitMessage(agentType, uptime, exitInfo, stderrOutput)
		slog.Error("Agent rapid exit", "message", errMsg)
		h.reportAgentError(agentType, "agent_crash", errMsg, stderrOutput)
	}

	h.mu.Lock()
	if h.process != process {
		h.mu.Unlock()
		slog.Info("Agent process monitor: process replaced, skipping status/restart")
		return
	}

	if h.status == HostStopped {
		h.mu.Unlock()
		slog.Info("Agent process monitor: session stopped, skipping restart")
		return
	}
	if rollover != nil && rollover.terminal.Load() {
		h.clearCurrentAgentSessionLocked()
		if h.statusErr == "" {
			h.statusErr = "checkpoint rollover terminated before process restart"
		}
		h.setStatusLocked(HostError)
		if h.checkpointRollover == rollover {
			h.checkpointRollover = nil
		}
		h.mu.Unlock()
		slog.Info("Checkpoint terminal owner suppressed delayed process restart", "acpSessionId", rollover.sessionID)
		return
	}
	h.promptMu.Lock()
	promptActive := h.promptInFlight
	h.promptMu.Unlock()
	if promptActive && !crashRecovery.inProgress && !intentionalPromptCancel && rollover == nil {
		h.clearCurrentAgentSessionLocked()
		h.setStatusLocked(HostError)
		errMsg := fmt.Sprintf("Agent process exited during an active prompt (%s)", exitInfo)
		h.statusErr = errMsg
		h.mu.Unlock()
		h.completeActivePromptFailure(errMsg)
		h.broadcastAgentStatus(StatusError, agentType, errMsg)
		h.reportActivity("error")
		return
	}

	if isRapidExit && !intentionalPromptCancel && rollover == nil {
		h.clearCurrentAgentSessionLocked()
		if crashRecovery.inProgress {
			h.clearCrashRecoveryLocked()
		}
		h.setStatusLocked(HostError)
		errMsg := rapidExitMessage(agentType, uptime, exitInfo, stderrOutput)
		h.statusErr = errMsg
		h.mu.Unlock()
		h.finishCrashRecoveryFailure(crashRecovery, errMsg, fmt.Errorf("%s", errMsg), recoveryNotify)
		h.completeActivePromptFailure(errMsg)
		h.broadcastAgentStatus(StatusError, agentType, errMsg)
		h.reportActivity("error")
		return
	}

	maxRestarts := h.maxRestartAttempts()
	if !intentionalPromptCancel && rollover == nil {
		h.applyRestartDecayLocked()
		h.restartCount++
		h.lastCrashTime = time.Now()
		if h.restartCount > maxRestarts {
			h.handleMaxRestartsExceededLocked(agentType, stderrOutput, maxRestarts, crashRecovery, recoveryNotify)
			return
		}
	}

	h.clearCurrentAgentSessionLocked()
	h.setStatusLocked(HostStarting)
	h.mu.Unlock()
	// Publish the detached process's inactive harness state immediately. The
	// replacement may fail before ACP attachment, so waiting for a later ready
	// report could leave the old active lease in the control plane until expiry.
	h.reportActivity("recovering")

	if rollover != nil {
		slog.Info("Attempting strict agent restart for checkpoint rollover", "acpSessionId", rollover.sessionID, "forced", rolloverForced)
	} else if intentionalPromptCancel {
		slog.Info("Attempting agent restart after user prompt cancel", "restartCount", h.restartCount, "maxRestarts", maxRestarts)
	} else {
		slog.Info("Attempting agent restart", "attempt", h.restartCount, "maxRestarts", maxRestarts)
	}
	h.broadcastAgentStatus(StatusRestarting, agentType, "")

	time.Sleep(time.Second)

	h.mu.Lock()
	if h.status == HostStopped {
		h.mu.Unlock()
		return
	}
	if rollover != nil && rollover.terminal.Load() {
		if h.statusErr == "" {
			h.statusErr = "checkpoint rollover terminated before strict resume"
		}
		h.setStatusLocked(HostError)
		if h.checkpointRollover == rollover {
			h.checkpointRollover = nil
		}
		h.mu.Unlock()
		slog.Info("Checkpoint terminal owner suppressed strict resume", "acpSessionId", rollover.sessionID)
		return
	}
	loadSessionID := ""
	if rollover != nil {
		loadSessionID = rollover.sessionID
	} else if intentionalPromptCancel || crashRecovery.inProgress {
		loadSessionID = previousAcpSessionID
		// Fall back to the captured crash-recovery session ID only during an
		// active crash-recovery episode. The captured ID is meaningful for
		// LoadSession resume; scoping to inProgress keeps intentional cancels
		// from ever resuming a stale recovery session and makes the invariant
		// explicit for future refactors.
		if loadSessionID == "" && crashRecovery.inProgress {
			loadSessionID = crashRecovery.sessionID
		}
	}
	if rollover != nil {
		err := h.startAgentForCrashRecovery(rollover.operationCtx, agentType, cred, settings, loadSessionID)
		if rollover.terminal.Load() {
			h.stopCurrentAgentLocked()
			if h.statusErr == "" {
				h.statusErr = "checkpoint rollover terminated during strict resume"
			}
			h.setStatusLocked(HostError)
			h.checkpointRollover = nil
			h.mu.Unlock()
			return
		}
		if err != nil {
			message := fmt.Sprintf("strict same-session checkpoint resume failed: %s", redactAgentDiagnosticText(err.Error()))
			h.stopCurrentAgentLocked()
			h.setStatusLocked(HostError)
			h.statusErr = message
			h.checkpointRollover = nil
			result := CheckpointRolloverResult{State: "failed", Forced: rollover.forced,
				ACPSessionID: rollover.sessionID, ErrorCode: "strict_resume_failed", ErrorMessage: message}
			rollover.complete(result, true)
			h.mu.Unlock()
			rollover.attempt.completeCheckpoint(h, fatalErrorStopReason, errors.New(message))
			h.broadcastAgentStatus(StatusError, agentType, message)
			h.reportActivity("error")
			return
		}
		if string(h.sessionID) != rollover.sessionID {
			message := "strict checkpoint resume returned a different ACP session"
			h.stopCurrentAgentLocked()
			h.setStatusLocked(HostError)
			h.statusErr = message
			h.checkpointRollover = nil
			result := CheckpointRolloverResult{State: "failed", Forced: rollover.forced,
				ACPSessionID: rollover.sessionID, ErrorCode: "session_identity_mismatch", ErrorMessage: message}
			rollover.complete(result, true)
			h.mu.Unlock()
			rollover.attempt.completeCheckpoint(h, fatalErrorStopReason, errors.New(message))
			h.broadcastAgentStatus(StatusError, agentType, message)
			h.reportActivity("error")
			return
		}
		result := CheckpointRolloverResult{State: "completed", Forced: rollover.forced, ACPSessionID: rollover.sessionID}
		decided, promptWon := rollover.completeStrictResume(h, result)
		if !promptWon && decided.State != "superseded" {
			h.stopCurrentAgentLocked()
			h.setStatusLocked(HostError)
			if h.statusErr == "" {
				h.statusErr = "checkpoint rollover terminal owner won during strict resume"
			}
			h.checkpointRollover = nil
			h.mu.Unlock()
			return
		}
		h.setStatusLocked(HostReady)
		h.statusErr = ""
		h.checkpointRollover = nil
		h.mu.Unlock()
		h.stopPromptActivityRereport()
		h.broadcastControl(MsgSessionPromptDone, nil)
		h.broadcastAgentStatus(StatusReady, agentType, "")
		h.reportActivity("idle")
		return
	}
	if !h.restartAgentLocked(ctx, agentType, cred, settings, loadSessionID, crashRecovery, recoveryNotify) {
		return
	}
	if !crashRecovery.inProgress {
		// Normal (non-recovery) restart succeeded.
		h.mu.Unlock()
		h.broadcastAgentStatus(StatusReady, agentType, "")
		return
	}

	// Crash-recovery restart succeeded. Clear the recovery episode state now
	// that a healthy process is installed, so the watchdog short-circuits and
	// never tears down the freshly-restarted process. A successful restart +
	// LoadSession is reported as "recovered" for every agent type (claude-code
	// and openai-codex alike): the resumed ACP session retains the same session
	// ID and conversation state, so the task can continue with awaiting_followup
	// rather than being marked as a terminal failure.
	h.clearCrashRecoveryLocked()
	h.mu.Unlock()

	h.broadcastAgentStatus(StatusRecovered, agentType, "")
	h.broadcastAgentCrashReport(h.crashReport(crashRecovery, true, ""))
	if recoveryNotify != nil {
		recoveryNotify(crashRecoveredStopReason, nil)
	}
	h.reportActivity("idle")
}

func agentExitInfo(err error) string {
	if err != nil {
		return fmt.Sprintf("exit=%v", err)
	}
	return "exit=0"
}

func rapidExitMessage(agentType string, uptime time.Duration, exitInfo, stderrOutput string) string {
	errMsg := fmt.Sprintf("Agent %s crashed on startup (exited in %v, %s)", agentType, uptime.Round(time.Millisecond), exitInfo)
	if stderrOutput != "" {
		return fmt.Sprintf("%s: %s", errMsg, truncate(stderrOutput, 500))
	}
	return errMsg
}

func (h *SessionHost) clearCurrentAgentSessionLocked() {
	// Harness-owned work belongs to this exact ACP process/session. Cancel its
	// heartbeat at the detach boundary so a crash whose restart never reaches
	// attachACPConnection cannot renew an active lease forever.
	h.clearHarnessWork()
	h.process = nil
	h.acpConn = nil
	h.setSessionIDLocked("")
	h.agentSupportsLoadSession = false
}

func (h *SessionHost) maxRestartAttempts() int {
	if h.config.MaxRestartAttempts != 0 {
		return h.config.MaxRestartAttempts
	}
	return 3
}

func (h *SessionHost) applyRestartDecayLocked() {
	if h.lastCrashTime.IsZero() {
		return
	}
	if time.Since(h.lastCrashTime) > h.restartDecayWindow() {
		h.restartCount = 0
	}
}

func (h *SessionHost) handleMaxRestartsExceededLocked(agentType, stderrOutput string, maxRestarts int, crashRecovery crashRecoverySnapshot, notify recoveryNotify) {
	slog.Error("Agent exceeded max restart attempts", "maxRestarts", maxRestarts)
	h.clearCurrentAgentSessionLocked()
	if crashRecovery.inProgress {
		h.clearCrashRecoveryLocked()
	}
	h.setStatusLocked(HostError)
	crashMsg := "Agent crashed and could not be restarted"
	if stderrOutput != "" {
		crashMsg = fmt.Sprintf("%s: %s", crashMsg, truncate(stderrOutput, 500))
	}
	h.statusErr = crashMsg
	h.mu.Unlock()
	h.finishCrashRecoveryFailure(crashRecovery, crashMsg, fmt.Errorf("%s", crashMsg), notify)
	h.completeActivePromptFailure(crashMsg)
	h.broadcastAgentStatus(StatusError, agentType, crashMsg)
	h.reportAgentError(agentType, "agent_max_restarts", crashMsg, stderrOutput)
	h.reportActivity("error")
}

func (h *SessionHost) restartAgentLocked(ctx context.Context, agentType string, cred *agentCredential, settings *agentSettingsPayload, previousAcpSessionID string, crashRecovery crashRecoverySnapshot, notify recoveryNotify) bool {
	var err error
	if crashRecovery.inProgress {
		err = h.startAgentForCrashRecovery(ctx, agentType, cred, settings, previousAcpSessionID)
	} else {
		err = h.startAgent(ctx, agentType, cred, settings, previousAcpSessionID)
	}
	if err != nil {
		h.setStatusLocked(HostError)
		h.statusErr = err.Error()
		if crashRecovery.inProgress {
			h.clearCrashRecoveryLocked()
		}
		h.mu.Unlock()
		slog.Error("Agent restart failed", "error", err)
		h.finishCrashRecoveryFailure(crashRecovery, err.Error(), err, notify)
		h.completeActivePromptFailure(err.Error())
		h.broadcastAgentStatus(StatusError, agentType, err.Error())
		h.reportAgentError(agentType, "agent_restart_failed", err.Error(), "")
		return false
	}
	h.setStatusLocked(HostReady)
	h.statusErr = ""
	return true
}

func (h *SessionHost) completeActivePromptFailure(message string) {
	h.promptMu.Lock()
	attempt := h.promptAttempt
	active := h.promptInFlight
	h.promptMu.Unlock()
	if active && attempt != nil {
		attempt.complete(h, fatalErrorStopReason, errors.New(message))
		h.stopPromptActivityRereport()
	}
}

func (h *SessionHost) finishCrashRecoveryFailure(crashRecovery crashRecoverySnapshot, message string, err error, notify recoveryNotify) {
	if !crashRecovery.inProgress {
		return
	}
	h.broadcastAgentCrashReport(h.crashReport(crashRecovery, false, message))
	if notify != nil {
		notify(fatalErrorStopReason, err)
	}
}
