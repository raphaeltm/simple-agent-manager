package acp

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"syscall"
	"time"
)

const crashRecoveredStopReason = "recovered"

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

func (h *SessionHost) beginCrashRecovery(reqID json.RawMessage, viewerID string) (string, bool) {
	stderr := h.peekStderr()
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.sessionID == "" || !h.agentSupportsLoadSession || h.agentType == "" {
		return "", false
	}

	h.crashRecoveryInProgress = true
	h.crashStderr = stderr
	h.crashAgentType = h.agentType
	h.crashPromptReqID = append(json.RawMessage(nil), reqID...)
	h.crashPromptViewerID = viewerID
	h.status = HostStarting
	h.statusErr = ""
	return h.agentType, true
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
		Type:             MsgAgentCrashReport,
		AgentType:        agentType,
		Recovered:        recovered,
		Message:          message,
		Attribution:      fmt.Sprintf("This is a bug in %s, not in SAM.", displayName),
		Stderr:           snapshot.stderr,
		StderrTruncated:  len(snapshot.stderr) >= h.config.StderrBufferBytes,
		Suggestion:       fmt.Sprintf("Please report this to %s with the debugging information above. Review stderr for secrets before sharing it outside your team.", agentVendorName(agentType)),
		Timestamp:        time.Now().UTC(),
		RecoveryError:    recoveryErr,
		OriginalPromptID: snapshot.promptReqID,
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
