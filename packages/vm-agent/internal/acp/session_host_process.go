package acp

import (
	"context"
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
	previousAcpSessionID := string(h.sessionID)
	crashRecovery := h.crashRecoverySnapshotLocked()
	recoveryNotify := process.RecoveryNotify()
	h.mu.Unlock()

	if isRapidExit && !intentionalPromptCancel {
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

	if isRapidExit && !intentionalPromptCancel {
		h.clearCurrentAgentSessionLocked()
		if crashRecovery.inProgress {
			h.clearCrashRecoveryLocked()
		}
		h.status = HostError
		errMsg := rapidExitMessage(agentType, uptime, exitInfo, stderrOutput)
		h.statusErr = errMsg
		h.mu.Unlock()
		h.finishCrashRecoveryFailure(crashRecovery, errMsg, fmt.Errorf("%s", errMsg), recoveryNotify)
		h.broadcastAgentStatus(StatusError, agentType, errMsg)
		// Report idle so the browser status bar clears the "prompting" spinner.
		// The error state is already broadcast via broadcastAgentStatus above.
		h.reportActivity("idle")
		return
	}

	maxRestarts := h.maxRestartAttempts()
	if !intentionalPromptCancel {
		h.applyRestartDecayLocked()
		h.restartCount++
		h.lastCrashTime = time.Now()
		if h.restartCount > maxRestarts {
			h.handleMaxRestartsExceededLocked(agentType, stderrOutput, maxRestarts, crashRecovery, recoveryNotify)
			return
		}
	}

	h.clearCurrentAgentSessionLocked()
	h.status = HostStarting
	h.mu.Unlock()

	if intentionalPromptCancel {
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
	loadSessionID := ""
	if intentionalPromptCancel || crashRecovery.inProgress {
		loadSessionID = previousAcpSessionID
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
	// never tears down the freshly-restarted process. The terminal-error
	// decision below intentionally keys off agentType via
	// resumeShouldReportTerminalErrorLocked, NOT off crashRecoveryInProgress,
	// so clearing the flag here cannot accidentally make the Codex branch
	// unreachable.
	h.clearCrashRecoveryLocked()
	if h.resumeShouldReportTerminalErrorLocked(agentType) {
		message := fmt.Sprintf("Agent %s LoadSession recovery needs staging validation before being reported as recovered", agentType)
		h.status = HostError
		h.statusErr = message
		h.mu.Unlock()
		h.finishCrashRecoveryFailure(crashRecovery, message, fmt.Errorf("%s", message), recoveryNotify)
		h.broadcastAgentStatus(StatusError, agentType, message)
		h.reportActivity("error")
		return
	}
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
	h.process = nil
	h.acpConn = nil
	h.sessionID = ""
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

func (h *SessionHost) resumeShouldReportTerminalErrorLocked(agentType string) bool {
	// TODO: empirically validate codex-acp LoadSession coherence on staging. Until
	// that round-trip proves coherent, report Codex disconnect recovery as a
	// terminal task error instead of a possibly misleading "recovered".
	return agentType == "openai-codex"
}

func (h *SessionHost) handleMaxRestartsExceededLocked(agentType, stderrOutput string, maxRestarts int, crashRecovery crashRecoverySnapshot, notify recoveryNotify) {
	slog.Error("Agent exceeded max restart attempts", "maxRestarts", maxRestarts)
	h.clearCurrentAgentSessionLocked()
	if crashRecovery.inProgress {
		h.clearCrashRecoveryLocked()
	}
	h.status = HostError
	crashMsg := "Agent crashed and could not be restarted"
	if stderrOutput != "" {
		crashMsg = fmt.Sprintf("%s: %s", crashMsg, truncate(stderrOutput, 500))
	}
	h.statusErr = crashMsg
	h.mu.Unlock()
	h.finishCrashRecoveryFailure(crashRecovery, crashMsg, fmt.Errorf("%s", crashMsg), notify)
	h.broadcastAgentStatus(StatusError, agentType, crashMsg)
	h.reportAgentError(agentType, "agent_max_restarts", crashMsg, stderrOutput)
}

func (h *SessionHost) restartAgentLocked(ctx context.Context, agentType string, cred *agentCredential, settings *agentSettingsPayload, previousAcpSessionID string, crashRecovery crashRecoverySnapshot, notify recoveryNotify) bool {
	var err error
	if crashRecovery.inProgress {
		err = h.startAgentForCrashRecovery(ctx, agentType, cred, settings, previousAcpSessionID)
	} else {
		err = h.startAgent(ctx, agentType, cred, settings, previousAcpSessionID)
	}
	if err != nil {
		h.status = HostError
		h.statusErr = err.Error()
		if crashRecovery.inProgress {
			h.clearCrashRecoveryLocked()
		}
		h.mu.Unlock()
		slog.Error("Agent restart failed", "error", err)
		h.finishCrashRecoveryFailure(crashRecovery, err.Error(), err, notify)
		h.broadcastAgentStatus(StatusError, agentType, err.Error())
		h.reportAgentError(agentType, "agent_restart_failed", err.Error(), "")
		return false
	}
	h.status = HostReady
	h.statusErr = ""
	return true
}

func (h *SessionHost) finishCrashRecoveryFailure(crashRecovery crashRecoverySnapshot, message string, err error, notify recoveryNotify) {
	if !crashRecovery.inProgress {
		return
	}
	h.broadcastAgentCrashReport(h.crashReport(crashRecovery, false, message))
	if notify != nil {
		notify("error", err)
	}
}
