package acp

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// monitorProcessExit detects agent crashes and attempts restart.
func (h *SessionHost) monitorProcessExit(ctx context.Context, process *AgentProcess, agentType string, cred *agentCredential, settings *agentSettingsPayload) {
	err := process.Wait()

	time.Sleep(100 * time.Millisecond)
	stderrOutput := redactAgentDiagnosticText(h.getAndClearStderr())
	uptime := time.Since(process.startTime)
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
		h.finishCrashRecoveryFailure(crashRecovery, errMsg, fmt.Errorf("%s", errMsg))
		h.broadcastAgentStatus(StatusError, agentType, errMsg)
		return
	}

	maxRestarts := h.maxRestartAttempts()
	if !intentionalPromptCancel {
		h.restartCount++
		if h.restartCount > maxRestarts {
			h.handleMaxRestartsExceededLocked(agentType, stderrOutput, maxRestarts, crashRecovery)
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
	if !h.restartAgentLocked(ctx, agentType, cred, settings, loadSessionID, crashRecovery) {
		return
	}
	if crashRecovery.inProgress {
		h.clearCrashRecoveryLocked()
	}
	h.mu.Unlock()

	if crashRecovery.inProgress {
		h.broadcastAgentStatus(StatusRecovered, agentType, "")
		h.broadcastAgentCrashReport(h.crashReport(crashRecovery, true, ""))
		h.notifyPromptComplete(crashRecoveredStopReason, nil)
		h.reportActivity("idle")
		return
	}
	h.broadcastAgentStatus(StatusReady, agentType, "")
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

func (h *SessionHost) handleMaxRestartsExceededLocked(agentType, stderrOutput string, maxRestarts int, crashRecovery crashRecoverySnapshot) {
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
	h.finishCrashRecoveryFailure(crashRecovery, crashMsg, fmt.Errorf("%s", crashMsg))
	h.broadcastAgentStatus(StatusError, agentType, crashMsg)
	h.reportAgentError(agentType, "agent_max_restarts", crashMsg, stderrOutput)
}

func (h *SessionHost) restartAgentLocked(ctx context.Context, agentType string, cred *agentCredential, settings *agentSettingsPayload, previousAcpSessionID string, crashRecovery crashRecoverySnapshot) bool {
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
		h.finishCrashRecoveryFailure(crashRecovery, err.Error(), err)
		h.broadcastAgentStatus(StatusError, agentType, err.Error())
		h.reportAgentError(agentType, "agent_restart_failed", err.Error(), "")
		return false
	}
	h.status = HostReady
	h.statusErr = ""
	return true
}

func (h *SessionHost) finishCrashRecoveryFailure(crashRecovery crashRecoverySnapshot, message string, err error) {
	if !crashRecovery.inProgress {
		return
	}
	h.broadcastAgentCrashReport(h.crashReport(crashRecovery, false, message))
	h.notifyPromptComplete("error", err)
}
