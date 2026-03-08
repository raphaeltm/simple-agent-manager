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

func TestExtractMessages_ThoughtChunk_Extracted(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			AgentThoughtChunk: &acpsdk.SessionUpdateAgentThoughtChunk{
				Content: acpsdk.ContentBlock{
					Text: &acpsdk.ContentBlockText{Text: "thinking about the problem..."},
				},
			},
		},
	}

	msgs := ExtractMessages(notif)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].Role != "thinking" {
		t.Fatalf("expected role=thinking, got %q", msgs[0].Role)
	}
	if msgs[0].Content != "thinking about the problem..." {
		t.Fatalf("expected thinking content, got %q", msgs[0].Content)
	}
	if msgs[0].ToolMetadata != "" {
		t.Fatalf("expected no tool metadata for thinking, got %q", msgs[0].ToolMetadata)
	}
}

func TestExtractMessages_ThoughtChunk_EmptyText(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			AgentThoughtChunk: &acpsdk.SessionUpdateAgentThoughtChunk{
				Content: acpsdk.ContentBlock{
					Text: &acpsdk.ContentBlockText{Text: ""},
				},
			},
		},
	}

	msgs := ExtractMessages(notif)
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages for empty thinking, got %d", len(msgs))
	}
}

func TestExtractMessages_Plan_Extracted(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			Plan: &acpsdk.SessionUpdatePlan{
				Entries: []acpsdk.PlanEntry{
					{Content: "Read the file", Priority: "high", Status: "completed"},
					{Content: "Make changes", Priority: "high", Status: "in_progress"},
					{Content: "Run tests", Priority: "medium", Status: "pending"},
				},
			},
		},
	}

	msgs := ExtractMessages(notif)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].Role != "plan" {
		t.Fatalf("expected role=plan, got %q", msgs[0].Role)
	}

	// Verify content is valid JSON array of plan entries
	var entries []struct {
		Content  string `json:"content"`
		Priority string `json:"priority"`
		Status   string `json:"status"`
	}
	if err := json.Unmarshal([]byte(msgs[0].Content), &entries); err != nil {
		t.Fatalf("expected valid JSON plan entries, got error: %v", err)
	}
	if len(entries) != 3 {
		t.Fatalf("expected 3 plan entries, got %d", len(entries))
	}
	if entries[0].Content != "Read the file" {
		t.Fatalf("expected first entry 'Read the file', got %q", entries[0].Content)
	}
	if entries[1].Status != "in_progress" {
		t.Fatalf("expected second entry status 'in_progress', got %q", entries[1].Status)
	}
}

func TestExtractMessages_Plan_EmptyEntries(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			Plan: &acpsdk.SessionUpdatePlan{
				Entries: []acpsdk.PlanEntry{},
			},
		},
	}

	msgs := ExtractMessages(notif)
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages for empty plan, got %d", len(msgs))
	}
}

func TestExtractMessages_ToolCall(t *testing.T) {
	line := 42
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCall: &acpsdk.SessionUpdateToolCall{
				ToolCallId: "tc-123",
				Title:      "Read file /src/main.go",
				Kind:       acpsdk.ToolKindRead,
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
	if meta.ToolCallId != "tc-123" {
		t.Fatalf("expected toolCallId='tc-123', got %q", meta.ToolCallId)
	}
	if meta.Title != "Read file /src/main.go" {
		t.Fatalf("expected title='Read file /src/main.go', got %q", meta.Title)
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
	// Verify structured content
	if len(meta.Content) != 1 {
		t.Fatalf("expected 1 structured content item, got %d", len(meta.Content))
	}
	if meta.Content[0].Type != "content" {
		t.Fatalf("expected content type='content', got %q", meta.Content[0].Type)
	}
	if meta.Content[0].Text != "file contents here" {
		t.Fatalf("expected content text='file contents here', got %q", meta.Content[0].Text)
	}
}

func TestExtractMessages_ToolCallUpdate_WithStatus(t *testing.T) {
	status := acpsdk.ToolCallStatusCompleted
	title := "Finished reading file"
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
				ToolCallId: "tc-456",
				Status:     &status,
				Title:      &title,
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
	if err := json.Unmarshal([]byte(msgs[0].ToolMetadata), &meta); err != nil {
		t.Fatalf("unmarshal tool metadata: %v", err)
	}
	if meta.ToolCallId != "tc-456" {
		t.Fatalf("expected toolCallId='tc-456', got %q", meta.ToolCallId)
	}
	if meta.Status != "completed" {
		t.Fatalf("expected status=completed, got %q", meta.Status)
	}
	if meta.Title != "Finished reading file" {
		t.Fatalf("expected title='Finished reading file', got %q", meta.Title)
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

func TestExtractMessages_ToolCallDiff_WithContent(t *testing.T) {
	oldText := "old content"
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCall: &acpsdk.SessionUpdateToolCall{
				ToolCallId: "tc-diff-1",
				Title:      "Edit file /src/main.go",
				Kind:       acpsdk.ToolKindEdit,
				Content: []acpsdk.ToolCallContent{
					{
						Diff: &acpsdk.ToolCallContentDiff{
							Path:    "/src/main.go",
							OldText: &oldText,
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

	// Verify structured content preserves diff type with full content
	var meta ToolMeta
	if err := json.Unmarshal([]byte(msgs[0].ToolMetadata), &meta); err != nil {
		t.Fatalf("unmarshal tool metadata: %v", err)
	}
	if meta.ToolCallId != "tc-diff-1" {
		t.Fatalf("expected toolCallId='tc-diff-1', got %q", meta.ToolCallId)
	}
	if meta.Title != "Edit file /src/main.go" {
		t.Fatalf("expected title='Edit file /src/main.go', got %q", meta.Title)
	}
	if len(meta.Content) != 1 {
		t.Fatalf("expected 1 structured content item, got %d", len(meta.Content))
	}
	if meta.Content[0].Type != "diff" {
		t.Fatalf("expected content type='diff', got %q", meta.Content[0].Type)
	}
	if meta.Content[0].Path != "/src/main.go" {
		t.Fatalf("expected path='/src/main.go', got %q", meta.Content[0].Path)
	}
	if meta.Content[0].OldText == nil || *meta.Content[0].OldText != "old content" {
		t.Fatalf("expected oldText='old content', got %v", meta.Content[0].OldText)
	}
	if meta.Content[0].NewText != "new content" {
		t.Fatalf("expected newText='new content', got %q", meta.Content[0].NewText)
	}
	// Text field should still contain the path for backward compat
	if meta.Content[0].Text != "/src/main.go" {
		t.Fatalf("expected text='/src/main.go', got %q", meta.Content[0].Text)
	}
}

func TestExtractMessages_ToolCallDiff_NoOldText(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCall: &acpsdk.SessionUpdateToolCall{
				Title: "Create file /src/new.go",
				Kind:  acpsdk.ToolKindEdit,
				Content: []acpsdk.ToolCallContent{
					{
						Diff: &acpsdk.ToolCallContentDiff{
							Path:    "/src/new.go",
							NewText: "new file content",
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

	var meta ToolMeta
	if err := json.Unmarshal([]byte(msgs[0].ToolMetadata), &meta); err != nil {
		t.Fatalf("unmarshal tool metadata: %v", err)
	}
	if meta.Content[0].OldText != nil {
		t.Fatalf("expected nil oldText for new file, got %v", meta.Content[0].OldText)
	}
	if meta.Content[0].NewText != "new file content" {
		t.Fatalf("expected newText='new file content', got %q", meta.Content[0].NewText)
	}
}

func TestTruncateContent(t *testing.T) {
	// Save and restore original value
	orig := maxToolContentSize
	defer func() { maxToolContentSize = orig }()

	maxToolContentSize = 10 // small limit for testing

	short := "hello"
	if result := truncateContent(short); result != short {
		t.Fatalf("expected short content unchanged, got %q", result)
	}

	long := "hello world this is too long"
	result := truncateContent(long)
	if len(result) <= 10 {
		t.Fatalf("expected truncated content to include marker, got %q", result)
	}
	if result[:10] != long[:10] {
		t.Fatalf("expected truncated content to start with original, got %q", result)
	}
}
