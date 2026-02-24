package acp

import (
	"encoding/json"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/google/uuid"
)

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
	Kind      string `json:"kind,omitempty"`
	Status    string `json:"status,omitempty"`
	Locations []struct {
		Path string `json:"path,omitempty"`
		Line *int   `json:"line,omitempty"`
	} `json:"locations,omitempty"`
}

// ExtractMessages converts an ACP SessionNotification into zero or more
// ExtractedMessage values suitable for the message reporter.
//
// Not every notification type produces a message. Only user/assistant text
// chunks and tool calls generate output. Thought chunks and plan updates
// are ignored to avoid flooding the chat history.
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

	// Tool call → role "tool"
	if u.ToolCall != nil {
		content := extractToolCallContents(u.ToolCall.Content)
		meta := ToolMeta{
			Kind: string(u.ToolCall.Kind),
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
		meta := ToolMeta{}
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
