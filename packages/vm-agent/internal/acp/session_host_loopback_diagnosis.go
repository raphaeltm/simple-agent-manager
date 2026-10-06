package acp

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/google/uuid"
)

const unsupportedLoopbackAuthMessage = "This sign-in flow requires a local callback that this session cannot complete."

func validLoopbackPromptMessageID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, char := range id {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') || char == '-' || char == '_' || char == '.' || char == ':' {
			continue
		}
		return false
	}
	return true
}

// reportUnsupportedLoopbackAuth is called only after a structurally valid URL
// request has been rejected solely for an explicit loopback callback. Recheck
// the live generation, exact prompt attempt, and request cancellation under
// the same lock order used by URL waiter registration. Reserve a fixed entry
// there, then release lifecycle locks before persistence, which may block on
// the reporter's SQLite queue. The reservation is the attribution point;
// persistence may complete after that prompt settles.
func (h *SessionHost) reportUnsupportedLoopbackAuth(ctx context.Context, generation string, attemptID uint64) {
	if h.config.MessageReporter == nil || h.config.SessionID == "" {
		return
	}
	h.promptMu.Lock()
	h.interactionMu.Lock()
	if !h.interactionConfig.Enabled || !h.interactionConfig.URLsEnabled ||
		generation == "" || generation != h.interactionGeneration ||
		!h.promptInFlight || h.promptAttempt == nil || h.promptAttempt.id != attemptID ||
		h.promptAttempt.ctx.Err() != nil || ctx.Err() != nil {
		h.interactionMu.Unlock()
		h.promptMu.Unlock()
		return
	}
	// Only the control-plane prompt's structural message ID can anchor UI
	// guidance across delayed persistence. Never include URL or wrapper data.
	if !validLoopbackPromptMessageID(h.promptAttempt.messageID) {
		h.interactionMu.Unlock()
		h.promptMu.Unlock()
		return
	}
	metadata, err := json.Marshal(struct {
		PromptMessageID string `json:"promptMessageId"`
	}{PromptMessageID: h.promptAttempt.messageID})
	if err != nil {
		h.interactionMu.Unlock()
		h.promptMu.Unlock()
		return
	}
	entry := MessageReportEntry{
		MessageID: uuid.NewString(), SessionID: h.config.SessionID, Role: "system",
		Content: unsupportedLoopbackAuthMessage, Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		ToolMetadata: string(metadata),
	}
	h.interactionMu.Unlock()
	h.promptMu.Unlock()
	if err := h.config.MessageReporter.Enqueue(entry); err != nil {
		// Reporter errors are not allowed to add untrusted URL metadata to logs.
		slog.Warn("Failed to persist loopback auth guidance")
	}
}
