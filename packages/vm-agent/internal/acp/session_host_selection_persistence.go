package acp

import (
	"log/slog"
	"time"

	"github.com/google/uuid"
)

type sessionErrorUpdater interface {
	MarkError(workspaceID, sessionID, agentType, message string) error
}

func (h *SessionHost) persistAgentSelectionFailure(agentType, message string) {
	message = redactAgentDiagnosticText(message)
	if updater, ok := h.config.SessionManager.(sessionErrorUpdater); ok && h.config.SessionID != "" {
		if err := updater.MarkError(h.config.WorkspaceID, h.config.SessionID, agentType, message); err != nil {
			slog.Warn("Failed to persist agent selection error", "error", err)
		}
	}
	if h.config.MessageReporter != nil && h.config.SessionID != "" {
		content := "Agent startup failed: " + message
		if message == "model_provider_credential_missing" {
			content = "Agent startup failed because its provider connection is missing."
		}
		if err := h.config.MessageReporter.Enqueue(MessageReportEntry{
			MessageID: uuid.NewString(), SessionID: h.config.SessionID, Role: "system",
			Content: content, Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		}); err != nil {
			slog.Warn("Failed to persist agent selection system message", "error", err)
		}
	}
}
