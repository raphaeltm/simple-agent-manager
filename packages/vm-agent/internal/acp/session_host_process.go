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
	stderrOutput := h.getAndClearStderr()
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
		h.status = HostError
		errMsg := rapidExitMessage(agentType, uptime, exitInfo, stderrOutput)
		h.statusErr = errMsg
		h.mu.Unlock()
		h.broadcastAgentStatus(StatusError, agentType, errMsg)
		return
	}

	h.restartCount++
	maxRestarts := h.maxRestartAttempts()
	if h.restartCount > maxRestarts {
		h.handleMaxRestartsExceededLocked(agentType, stderrOutput, maxRestarts)
		return
	}

	h.clearCurrentAgentSessionLocked()
	h.status = HostStarting
	h.mu.Unlock()

	slog.Info("Attempting agent restart", "attempt", h.restartCount, "maxRestarts", maxRestarts)
	h.broadcastAgentStatus(StatusRestarting, agentType, "")

	time.Sleep(time.Second)

	h.mu.Lock()
	if h.status == HostStopped {
		h.mu.Unlock()
		return
	}
	if !h.restartAgentLocked(ctx, agentType, cred, settings) {
		return
	}
	h.mu.Unlock()

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
}

func (h *SessionHost) maxRestartAttempts() int {
	if h.config.MaxRestartAttempts != 0 {
		return h.config.MaxRestartAttempts
	}
	return 3
}

func (h *SessionHost) handleMaxRestartsExceededLocked(agentType, stderrOutput string, maxRestarts int) {
	slog.Error("Agent exceeded max restart attempts", "maxRestarts", maxRestarts)
	h.clearCurrentAgentSessionLocked()
	h.status = HostError
	crashMsg := "Agent crashed and could not be restarted"
	if stderrOutput != "" {
		crashMsg = fmt.Sprintf("%s: %s", crashMsg, truncate(stderrOutput, 500))
	}
	h.statusErr = crashMsg
	h.mu.Unlock()
	h.broadcastAgentStatus(StatusError, agentType, crashMsg)
	h.reportAgentError(agentType, "agent_max_restarts", crashMsg, stderrOutput)
}

func (h *SessionHost) restartAgentLocked(ctx context.Context, agentType string, cred *agentCredential, settings *agentSettingsPayload) bool {
	if err := h.startAgent(ctx, agentType, cred, settings, ""); err != nil {
		h.status = HostError
		h.statusErr = err.Error()
		h.mu.Unlock()
		slog.Error("Agent restart failed", "error", err)
		h.broadcastAgentStatus(StatusError, agentType, err.Error())
		h.reportAgentError(agentType, "agent_restart_failed", err.Error(), "")
		return false
	}
	h.status = HostReady
	h.statusErr = ""
	return true
}
