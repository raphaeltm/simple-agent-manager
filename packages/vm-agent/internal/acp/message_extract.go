package acp

import (
	"encoding/json"
	"os"
	"strconv"
	"unicode/utf8"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/google/uuid"
)

// maxToolContentSize is the maximum size (in bytes) for diff oldText/newText
// fields to prevent excessive storage. Configurable via MAX_TOOL_CONTENT_SIZE.
var maxToolContentSize = func() int {
	if v := os.Getenv("MAX_TOOL_CONTENT_SIZE"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 100 * 1024 // 100KB default
}()

// ExtractedMessage represents a chat message extracted from an ACP
// SessionNotification for persistence to the control plane.
type ExtractedMessage struct {
	MessageID    string `json:"messageId"`
	Role         string `json:"role"`
	Content      string `json:"content"`
	ToolMetadata string `json:"toolMetadata,omitempty"` // JSON string
}

// ToolMeta holds structured tool call metadata serialized as JSON into
// the ToolMetadata field of ExtractedMessage.
type ToolMeta struct {
	ToolCallId string `json:"toolCallId,omitempty"`
	Title      string `json:"title,omitempty"`
	Kind       string `json:"kind,omitempty"`
	Status     string `json:"status,omitempty"`
	Locations  []struct {
		Path string `json:"path,omitempty"`
		Line *int   `json:"line,omitempty"`
	} `json:"locations,omitempty"`
	// Content stores each ACP ToolCallContent block as raw JSON, preserving
	// the exact wire format the frontend expects (including type discriminator,
	// nested content blocks, and all fields). This ensures the persisted path
	// produces the same shape as the real-time ACP WebSocket path.
	Content []json.RawMessage `json:"content,omitempty"`
}

// ExtractMessages converts an ACP SessionNotification into zero or more
// ExtractedMessage values suitable for the message reporter.
//
// Extracts user/assistant text chunks, tool calls, thinking blocks, and
// plan updates for persistence to the control plane.
func ExtractMessages(notif acpsdk.SessionNotification) []ExtractedMessage {
	u := notif.Update
	var msgs []ExtractedMessage

	// User message chunk → role "user"
	if u.UserMessageChunk != nil {
		text := extractContentBlockText(u.UserMessageChunk.Content)
		if text != "" {
			msgs = append(msgs, ExtractedMessage{
				MessageID: uuid.NewString(),
				Role:      "user",
				Content:   text,
			})
		}
	}

	// Agent message chunk → role "assistant"
	if u.AgentMessageChunk != nil {
		text := extractContentBlockText(u.AgentMessageChunk.Content)
		if text != "" {
			msgs = append(msgs, ExtractedMessage{
				MessageID: uuid.NewString(),
				Role:      "assistant",
				Content:   text,
			})
		}
	}

	// Agent thought chunk → role "thinking"
	if u.AgentThoughtChunk != nil {
		text := extractContentBlockText(u.AgentThoughtChunk.Content)
		if text != "" {
			msgs = append(msgs, ExtractedMessage{
				MessageID: uuid.NewString(),
				Role:      "thinking",
				Content:   text,
			})
		}
	}

	// Plan update → role "plan"
	if u.Plan != nil {
		planJSON, err := json.Marshal(u.Plan.Entries)
		if err == nil && len(u.Plan.Entries) > 0 {
			msgs = append(msgs, ExtractedMessage{
				MessageID: uuid.NewString(),
				Role:      "plan",
				Content:   string(planJSON),
			})
		}
	}

	// Tool call → role "tool"
	if u.ToolCall != nil {
		content := extractToolCallContents(u.ToolCall.Content)
		meta := ToolMeta{
			ToolCallId: string(u.ToolCall.ToolCallId),
			Title:      u.ToolCall.Title,
			Kind:       string(u.ToolCall.Kind),
			Status:     string(u.ToolCall.Status),
			Content:    marshalRawContent(u.ToolCall.Content),
		}
		for _, loc := range u.ToolCall.Locations {
			meta.Locations = append(meta.Locations, struct {
				Path string `json:"path,omitempty"`
				Line *int   `json:"line,omitempty"`
			}{Path: loc.Path, Line: loc.Line})
		}
		metaJSON, _ := json.Marshal(meta)

		if content == "" {
			content = "(tool call)"
		}
		msgs = append(msgs, ExtractedMessage{
			MessageID:    uuid.NewString(),
			Role:         "tool",
			Content:      content,
			ToolMetadata: string(metaJSON),
		})
	}

	// Tool call update → role "tool" (status update)
	if u.ToolCallUpdate != nil {
		content := extractToolCallContents(u.ToolCallUpdate.Content)
		meta := ToolMeta{
			ToolCallId: string(u.ToolCallUpdate.ToolCallId),
			Content:    marshalRawContent(u.ToolCallUpdate.Content),
		}
		if u.ToolCallUpdate.Title != nil {
			meta.Title = *u.ToolCallUpdate.Title
		}
		if u.ToolCallUpdate.Kind != nil {
			meta.Kind = string(*u.ToolCallUpdate.Kind)
		}
		if u.ToolCallUpdate.Status != nil {
			meta.Status = string(*u.ToolCallUpdate.Status)
		}
		for _, loc := range u.ToolCallUpdate.Locations {
			meta.Locations = append(meta.Locations, struct {
				Path string `json:"path,omitempty"`
				Line *int   `json:"line,omitempty"`
			}{Path: loc.Path, Line: loc.Line})
		}

		// Only emit a message if there is meaningful content or a status change.
		if content != "" || meta.Status != "" {
			metaJSON, _ := json.Marshal(meta)
			if content == "" {
				content = "(tool update)"
			}
			msgs = append(msgs, ExtractedMessage{
				MessageID:    uuid.NewString(),
				Role:         "tool",
				Content:      content,
				ToolMetadata: string(metaJSON),
			})
		}
	}

	return msgs
}

// extractContentBlockText extracts text from a ContentBlock.
// Returns empty string if the block is not a text block.
func extractContentBlockText(block acpsdk.ContentBlock) string {
	if block.Text != nil {
		return block.Text.Text
	}
	return ""
}

// truncateContent truncates text to maxToolContentSize bytes, appending
// a marker if truncated. It ensures the cut point falls on a valid UTF-8
// boundary to avoid producing garbled output.
func truncateContent(s string) string {
	if len(s) <= maxToolContentSize {
		return s
	}
	// Walk backwards from the limit to find a valid UTF-8 boundary.
	truncated := s[:maxToolContentSize]
	for len(truncated) > 0 && !utf8.ValidString(truncated) {
		truncated = truncated[:len(truncated)-1]
	}
	return truncated + "\n... [truncated]"
}

// marshalRawContent serializes ACP tool call content blocks to raw JSON,
// preserving the exact ACP wire format. This ensures the persisted path
// produces the same shape as the real-time ACP WebSocket path.
// Large diff fields (oldText/newText) are truncated before marshaling.
func marshalRawContent(contents []acpsdk.ToolCallContent) []json.RawMessage {
	var items []json.RawMessage
	for _, c := range contents {
		// Truncate large diff fields before marshaling to prevent
		// excessive storage while preserving the full structure.
		if c.Diff != nil {
			truncatedNew := truncateContent(c.Diff.NewText)
			var truncatedOld *string
			if c.Diff.OldText != nil {
				t := truncateContent(*c.Diff.OldText)
				truncatedOld = &t
			}
			c.Diff = &acpsdk.ToolCallContentDiff{
				Path:    c.Diff.Path,
				OldText: truncatedOld,
				NewText: truncatedNew,
			}
		}
		raw, err := json.Marshal(c)
		if err == nil && len(raw) > 2 { // Skip empty objects "{}"
			items = append(items, raw)
		}
	}
	return items
}

// extractToolCallContents aggregates text from tool call content blocks.
func extractToolCallContents(contents []acpsdk.ToolCallContent) string {
	var text string
	for _, c := range contents {
		if c.Content != nil && c.Content.Content.Text != nil {
			if text != "" {
				text += "\n"
			}
			text += c.Content.Content.Text.Text
		}
		if c.Diff != nil {
			if text != "" {
				text += "\n"
			}
			text += "diff: " + c.Diff.Path
		}
	}
	return text
}
