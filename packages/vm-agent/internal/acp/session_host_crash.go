package acp

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

const crashRecoveredStopReason = "recovered"

var diagnosticRedactionPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{16,}`),
	regexp.MustCompile(`(?i)((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,;]+)`),
	regexp.MustCompile(`\b(sk-[A-Za-z0-9_-]{12,})\b`),
	regexp.MustCompile(`\b(gh[pousr]_[A-Za-z0-9_]{12,})\b`),
	regexp.MustCompile(`\b(github_pat_[A-Za-z0-9_]{12,})\b`),
	regexp.MustCompile(`\b(sam_test_[A-Za-z0-9_-]{12,})\b`),
}

func isCrashPromptError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, syscall.EPIPE) || errors.Is(err, syscall.ECONNRESET) {
		return true
	}
	msg := strings.ToLower(err.Error())
	crashPatterns := []string{
		"broken pipe",
		"connection reset",
		"connection closed",
		"peer disconnected",
		"stdin is closed",
		"unexpected eof",
	}
	for _, pattern := range crashPatterns {
		if strings.Contains(msg, pattern) {
			return true
		}
	}
	return false
}

func redactAgentDiagnosticText(text string) string {
	redacted := text
	for _, pattern := range diagnosticRedactionPatterns {
		redacted = pattern.ReplaceAllStringFunc(redacted, func(match string) string {
			submatches := pattern.FindStringSubmatch(match)
			if len(submatches) >= 3 {
				return submatches[1] + "[REDACTED]"
			}
			if len(submatches) >= 2 && strings.HasSuffix(strings.ToLower(submatches[1]), " ") {
				return submatches[1] + "[REDACTED]"
			}
			return "[REDACTED]"
		})
	}
	return redacted
}

type recoveryNotify func(stopReason string, err error)

// beginCrashRecovery attempts to start LoadSession-based recovery after an agent crash.
// Returns recovery episode state when recovery is available. agentType and stderr are
// returned even when recovery is unavailable so the caller can use them without
// re-acquiring locks.
func (h *SessionHost) beginCrashRecovery(reqID json.RawMessage, viewerID string) (string, string, agentProcess, recoveryNotify, bool) {
	stderr := redactAgentDiagnosticText(h.peekStderr())
	h.mu.Lock()
	defer h.mu.Unlock()

	agentType := h.agentType
	if h.sessionID == "" || !h.agentSupportsLoadSession || agentType == "" {
		return agentType, stderr, nil, nil, false
	}

	once := &sync.Once{}
	notify := func(stopReason string, err error) {
		once.Do(func() {
			h.notifyPromptComplete(stopReason, err)
		})
	}
	process := h.process
	if process != nil {
		process.SetRecoveryNotify(notify)
	}
	h.crashRecoveryInProgress = true
	h.crashStderr = stderr
	h.crashAgentType = agentType
	h.crashPromptReqID = append(json.RawMessage(nil), reqID...)
	h.crashPromptViewerID = viewerID
	h.status = HostStarting
	h.statusErr = ""
	h.armCrashRecoveryWatchdogLocked(notify)
	return agentType, stderr, process, notify, true
}

type crashRecoverySnapshot struct {
	inProgress     bool
	stderr         string
	agentType      string
	promptReqID    json.RawMessage
	promptViewerID string
}

func (h *SessionHost) crashRecoverySnapshotLocked() crashRecoverySnapshot {
	return crashRecoverySnapshot{
		inProgress:     h.crashRecoveryInProgress,
		stderr:         h.crashStderr,
		agentType:      h.crashAgentType,
		promptReqID:    append(json.RawMessage(nil), h.crashPromptReqID...),
		promptViewerID: h.crashPromptViewerID,
	}
}

func (h *SessionHost) clearCrashRecoveryLocked() {
	h.crashRecoveryInProgress = false
	h.crashStderr = ""
	h.crashAgentType = ""
	h.crashPromptReqID = nil
	h.crashPromptViewerID = ""
}

func (h *SessionHost) recoveryWatchdogTimeout() time.Duration {
	if h.config.RecoveryWatchdogTimeout > 0 {
		return h.config.RecoveryWatchdogTimeout
	}
	return DefaultRecoveryWatchdogTimeout
}

func (h *SessionHost) restartDecayWindow() time.Duration {
	if h.config.RestartDecayWindow > 0 {
		return h.config.RestartDecayWindow
	}
	return DefaultRestartDecayWindow
}

func (h *SessionHost) armCrashRecoveryWatchdogLocked(notify recoveryNotify) {
	timeout := h.recoveryWatchdogTimeout()
	if timeout <= 0 {
		return
	}
	go h.watchCrashRecovery(timeout, notify)
}

func (h *SessionHost) watchCrashRecovery(timeout time.Duration, notify recoveryNotify) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case <-h.ctx.Done():
		return
	case <-timer.C:
	}

	message := fmt.Sprintf("Agent crash recovery timed out after %s", timeout)
	err := fmt.Errorf("%s", message)

	h.mu.Lock()
	if !h.crashRecoveryInProgress {
		h.mu.Unlock()
		return
	}
	snapshot := h.crashRecoverySnapshotLocked()
	process := h.process
	h.clearCurrentAgentSessionLocked()
	h.clearCrashRecoveryLocked()
	h.status = HostError
	h.statusErr = message
	h.mu.Unlock()

	if process != nil {
		go func() {
			if stopErr := process.Stop(); stopErr != nil {
				slog.Warn("Recovery watchdog failed to stop agent process", "error", stopErr)
			}
		}()
	}

	h.finishCrashRecoveryFailure(snapshot, message, err, notify)
	h.broadcastAgentStatus(StatusError, snapshot.agentType, message)
	h.reportActivity("error")
}

func (h *SessionHost) stopCrashedProcessForRecovery(proc agentProcess) {
	h.mu.Lock()
	if h.process != proc || !h.crashRecoveryInProgress {
		h.mu.Unlock()
		return
	}
	h.mu.Unlock()

	if err := proc.Stop(); err != nil {
		slog.Warn("Failed to stop crashed ACP agent process for recovery", "error", err)
	}
}

func (h *SessionHost) crashReport(snapshot crashRecoverySnapshot, recovered bool, recoveryErr string) AgentCrashReportMessage {
	agentType := snapshot.agentType
	if agentType == "" {
		agentType = h.AgentType()
	}
	displayName := agentDisplayName(agentType)

	message := fmt.Sprintf("The %s agent crashed unexpectedly. SAM recovered your session automatically. You can continue your conversation.", displayName)
	if !recovered {
		message = fmt.Sprintf("The %s agent crashed unexpectedly. SAM could not recover the session automatically.", displayName)
	}

	return AgentCrashReportMessage{
		Type:            MsgAgentCrashReport,
		AgentType:       agentType,
		Recovered:       recovered,
		Message:         message,
		Attribution:     fmt.Sprintf("The crash points to a bug in %s's agent process, not SAM's workspace runner.", displayName),
		Stderr:          redactAgentDiagnosticText(snapshot.stderr),
		StderrTruncated: len(snapshot.stderr) >= h.config.StderrBufferBytes,
		Suggestion:      fmt.Sprintf("Please report this to %s with the redacted debugging information above. Review diagnostics before sharing them outside your team.", agentVendorName(agentType)),
		Timestamp:       time.Now().UTC(),
		RecoveryError:   recoveryErr,
	}
}

func agentDisplayName(agentType string) string {
	switch agentType {
	case "openai-codex":
		return "Codex"
	case "claude-code":
		return "Claude Code"
	case "opencode":
		return "OpenCode"
	case "amp":
		return "Amp"
	default:
		if agentType == "" {
			return "agent"
		}
		return agentType
	}
}

func agentVendorName(agentType string) string {
	switch agentType {
	case "openai-codex":
		return "OpenAI"
	case "claude-code":
		return "Anthropic"
	default:
		return agentDisplayName(agentType)
	}
}
