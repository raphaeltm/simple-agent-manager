package acp

import (
	"encoding/json"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
)

func TestExtractMessages_UserMessageChunk(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			UserMessageChunk: &acpsdk.SessionUpdateUserMessageChunk{
				Content: acpsdk.ContentBlock{
					Text: &acpsdk.ContentBlockText{Text: "hello world"},
				},
			},
		},
	}

	msgs := ExtractMessages(notif)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].Role != "user" {
		t.Fatalf("expected role=user, got %q", msgs[0].Role)
	}
	if msgs[0].Content != "hello world" {
		t.Fatalf("expected content='hello world', got %q", msgs[0].Content)
	}
	if msgs[0].MessageID == "" {
		t.Fatal("expected non-empty messageId")
	}
}

func TestExtractMessages_AssistantMessageChunk(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			AgentMessageChunk: &acpsdk.SessionUpdateAgentMessageChunk{
				Content: acpsdk.ContentBlock{
					Text: &acpsdk.ContentBlockText{Text: "I can help with that"},
				},
			},
		},
	}

	msgs := ExtractMessages(notif)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].Role != "assistant" {
		t.Fatalf("expected role=assistant, got %q", msgs[0].Role)
	}
	if msgs[0].Content != "I can help with that" {
		t.Fatalf("expected content='I can help with that', got %q", msgs[0].Content)
	}
}

func TestExtractMessages_ToolCall(t *testing.T) {
	line := 42
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCall: &acpsdk.SessionUpdateToolCall{
				Kind: acpsdk.ToolKindRead,
				Content: []acpsdk.ToolCallContent{
					{
						Content: &acpsdk.ToolCallContentContent{
							Content: acpsdk.ContentBlock{
								Text: &acpsdk.ContentBlockText{Text: "file contents here"},
							},
						},
					},
				},
				Locations: []acpsdk.ToolCallLocation{
					{Path: "/src/main.go", Line: &line},
				},
			},
		},
	}

	msgs := ExtractMessages(notif)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].Role != "tool" {
		t.Fatalf("expected role=tool, got %q", msgs[0].Role)
	}
	if msgs[0].Content != "file contents here" {
		t.Fatalf("expected content='file contents here', got %q", msgs[0].Content)
	}

	// Verify tool metadata
	var meta ToolMeta
	if err := json.Unmarshal([]byte(msgs[0].ToolMetadata), &meta); err != nil {
		t.Fatalf("unmarshal tool metadata: %v", err)
	}
	if meta.Kind != "read" {
		t.Fatalf("expected kind=read, got %q", meta.Kind)
	}
	if len(meta.Locations) != 1 {
		t.Fatalf("expected 1 location, got %d", len(meta.Locations))
	}
	if meta.Locations[0].Path != "/src/main.go" {
		t.Fatalf("expected path=/src/main.go, got %q", meta.Locations[0].Path)
	}
	if meta.Locations[0].Line == nil || *meta.Locations[0].Line != 42 {
		t.Fatalf("expected line=42, got %v", meta.Locations[0].Line)
	}
}

func TestExtractMessages_ToolCallUpdate_WithStatus(t *testing.T) {
	status := acpsdk.ToolCallStatusCompleted
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
				Status: &status,
			},
		},
	}

	msgs := ExtractMessages(notif)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].Role != "tool" {
		t.Fatalf("expected role=tool, got %q", msgs[0].Role)
	}

	var meta ToolMeta
	json.Unmarshal([]byte(msgs[0].ToolMetadata), &meta)
	if meta.Status != "completed" {
		t.Fatalf("expected status=completed, got %q", meta.Status)
	}
}

func TestExtractMessages_EmptyNotification(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update:    acpsdk.SessionUpdate{},
	}

	msgs := ExtractMessages(notif)
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages for empty notification, got %d", len(msgs))
	}
}

func TestExtractMessages_ThoughtChunk_Ignored(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			AgentThoughtChunk: &acpsdk.SessionUpdateAgentThoughtChunk{
				Content: acpsdk.ContentBlock{
					Text: &acpsdk.ContentBlockText{Text: "thinking..."},
				},
			},
		},
	}

	msgs := ExtractMessages(notif)
	if len(msgs) != 0 {
		t.Fatalf("expected thought chunks to be ignored, got %d messages", len(msgs))
	}
}

func TestExtractMessages_UserChunk_EmptyText(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			UserMessageChunk: &acpsdk.SessionUpdateUserMessageChunk{
				Content: acpsdk.ContentBlock{
					Text: &acpsdk.ContentBlockText{Text: ""},
				},
			},
		},
	}

	msgs := ExtractMessages(notif)
	if len(msgs) != 0 {
		t.Fatalf("expected empty text to produce no messages, got %d", len(msgs))
	}
}

func TestExtractMessages_ToolCall_NoContent_FallbackLabel(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCall: &acpsdk.SessionUpdateToolCall{
				Kind: acpsdk.ToolKindExecute,
			},
		},
	}

	msgs := ExtractMessages(notif)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].Content != "(tool call)" {
		t.Fatalf("expected fallback content '(tool call)', got %q", msgs[0].Content)
	}
}

func TestExtractMessages_UniqueMessageIDs(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			UserMessageChunk: &acpsdk.SessionUpdateUserMessageChunk{
				Content: acpsdk.ContentBlock{
					Text: &acpsdk.ContentBlockText{Text: "msg1"},
				},
			},
		},
	}

	msgs1 := ExtractMessages(notif)
	msgs2 := ExtractMessages(notif)

	if len(msgs1) != 1 || len(msgs2) != 1 {
		t.Fatal("expected 1 message each")
	}
	if msgs1[0].MessageID == msgs2[0].MessageID {
		t.Fatal("expected unique messageIDs across calls")
	}
}

func TestExtractMessages_ToolCallDiff(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCall: &acpsdk.SessionUpdateToolCall{
				Kind: acpsdk.ToolKindEdit,
				Content: []acpsdk.ToolCallContent{
					{
						Diff: &acpsdk.ToolCallContentDiff{
							Path:    "/src/main.go",
							NewText: "new content",
						},
					},
				},
			},
		},
	}

	msgs := ExtractMessages(notif)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].Content != "diff: /src/main.go" {
		t.Fatalf("expected diff path in content, got %q", msgs[0].Content)
	}
}
