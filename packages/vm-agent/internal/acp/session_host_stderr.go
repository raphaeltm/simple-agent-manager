package acp

import (
	"bufio"
	"log/slog"
	"strings"

	acpsdk "github.com/coder/acp-go-sdk"
)

// DefaultStderrBufferBytes is the default maximum agent stderr captured for
// crash reports. Override via ACP_STDERR_BUFFER_BYTES.
const DefaultStderrBufferBytes = 4096

// monitorStderr reads the agent's stderr and collects it for error reporting.
func (h *SessionHost) monitorStderr(process agentProcess) {
	scanner := bufio.NewScanner(process.Stderr())
	for scanner.Scan() {
		line := redactAgentDiagnosticText(scanner.Text())
		slog.Warn("Agent stderr", "line", line)
		h.stderrMu.Lock()
		if h.stderrBuf.Len() < h.config.StderrBufferBytes {
			if h.stderrBuf.Len() > 0 {
				h.stderrBuf.WriteByte('\n')
			}
			h.stderrBuf.WriteString(line)
		}
		h.stderrMu.Unlock()
	}
}

func (h *SessionHost) getAndClearStderr() string {
	h.stderrMu.Lock()
	defer h.stderrMu.Unlock()
	s := h.stderrBuf.String()
	h.stderrBuf.Reset()
	return s
}

func (h *SessionHost) peekStderr() string {
	h.stderrMu.Lock()
	defer h.stderrMu.Unlock()
	return h.stderrBuf.String()
}

// silentErrorPatterns are stderr substrings that indicate an API-level error
// the agent may have swallowed (returning a normal end_turn instead of an error).
var silentErrorPatterns = []string{
	"AI_APICallError",
	"Unauthorized",
	"401",
	"403",
	"invalid_api_key",
	"authentication_error",
}

// checkStderrForSilentErrors peeks at the accumulated stderr buffer for known
// API error patterns. Some agents (notably OpenCode with Scaleway) silently
// swallow API errors and return {stopReason: "end_turn"} instead of an error.
// When detected, we log a warning and report a lifecycle event so the UI can
// surface the issue. The stderr buffer is NOT cleared — it remains available
// for crash reporting in monitorProcessExit.
func (h *SessionHost) checkStderrForSilentErrors(stopReason acpsdk.StopReason) {
	h.stderrMu.Lock()
	stderr := h.stderrBuf.String()
	h.stderrMu.Unlock()

	if stderr == "" {
		return
	}

	for _, pattern := range silentErrorPatterns {
		if strings.Contains(stderr, pattern) {
			slog.Warn("ACP: possible silent API error detected in stderr after prompt completion",
				"stopReason", string(stopReason),
				"pattern", pattern,
				"stderrSnippet", truncateString(stderr, 512),
				"agentType", h.AgentType(),
			)
			h.reportLifecycle("warn", "Possible silent API error — check agent credentials", map[string]interface{}{
				"stopReason":    string(stopReason),
				"errorPattern":  pattern,
				"stderrSnippet": truncateString(stderr, 256),
			})
			return // report once per prompt, not per pattern
		}
	}
}

// truncateString returns s truncated to maxLen with "..." appended if needed.
func truncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
