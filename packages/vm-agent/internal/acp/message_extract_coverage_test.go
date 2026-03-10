package acp

// Additional tests targeting uncovered branches in message_extract.go.
//
// Coverage gaps addressed:
//   - extractContentBlockText: nil block (no Text pointer) — line 188 false branch
//   - marshalRawContent: terminal content item
//   - extractToolCallContents: terminal content item (no text accumulated)
//   - ExtractMessages / ToolCallUpdate: update with no content and no status (skip path)
//   - ExtractMessages / ToolCallUpdate: update with Kind pointer set
//   - MAX_TOOL_CONTENT_SIZE env var: truncation applied inside marshalRawContent

import (
	"encoding/json"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
)

// unmarshalRawItem is a test helper that unmarshals a json.RawMessage into a map.
func unmarshalRawItem(t *testing.T, raw json.RawMessage) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal raw content item: %v", err)
	}
	return m
}

// ---------------------------------------------------------------------------
// extractContentBlockText: nil Text pointer → empty string
// ---------------------------------------------------------------------------

func TestExtractContentBlockText_NilText(t *testing.T) {
	// ContentBlock with no Text pointer set returns ""
	block := acpsdk.ContentBlock{} // Text is nil
	result := extractContentBlockText(block)
	if result != "" {
		t.Fatalf("expected empty string for nil Text, got %q", result)
	}
}

// AgentMessageChunk with a non-text (nil Text) content block must produce no message.
func TestExtractMessages_AgentChunk_NilText(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			AgentMessageChunk: &acpsdk.SessionUpdateAgentMessageChunk{
				Content: acpsdk.ContentBlock{}, // no Text
			},
		},
	}

	msgs := ExtractMessages(notif)
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages for nil-text agent chunk, got %d", len(msgs))
	}
}

// ---------------------------------------------------------------------------
// marshalRawContent: terminal content type
// ---------------------------------------------------------------------------

func TestMarshalRawContent_TerminalItem(t *testing.T) {
	contents := []acpsdk.ToolCallContent{
		{
			Terminal: &acpsdk.ToolCallContentTerminal{
				TerminalId: "term-42",
			},
		},
	}

	items := marshalRawContent(contents)
	if len(items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(items))
	}
	m := unmarshalRawItem(t, items[0])
	if m["type"] != "terminal" {
		t.Fatalf("expected type=terminal, got %v", m["type"])
	}
	if m["terminalId"] != "term-42" {
		t.Fatalf("expected terminalId=term-42, got %v", m["terminalId"])
	}
}

// ToolCall with terminal content produces a tool message with structured
// terminal item and the fallback "(tool call)" content text (no text content).
func TestExtractMessages_ToolCall_TerminalContent(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCall: &acpsdk.SessionUpdateToolCall{
				ToolCallId: "tc-term",
				Title:      "Run terminal",
				Kind:       acpsdk.ToolKindExecute,
				Content: []acpsdk.ToolCallContent{
					{
						Terminal: &acpsdk.ToolCallContentTerminal{
							TerminalId: "term-99",
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

	// extractToolCallContents finds no text for terminal blocks → fallback label
	if msgs[0].Content != "(tool call)" {
		t.Fatalf("expected fallback content '(tool call)', got %q", msgs[0].Content)
	}

	var meta ToolMeta
	if err := json.Unmarshal([]byte(msgs[0].ToolMetadata), &meta); err != nil {
		t.Fatalf("unmarshal tool metadata: %v", err)
	}
	if len(meta.Content) != 1 {
		t.Fatalf("expected 1 structured content item, got %d", len(meta.Content))
	}
	m := unmarshalRawItem(t, meta.Content[0])
	if m["type"] != "terminal" {
		t.Fatalf("expected type=terminal, got %v", m["type"])
	}
	if m["terminalId"] != "term-99" {
		t.Fatalf("expected terminalId=term-99, got %v", m["terminalId"])
	}
}

// ---------------------------------------------------------------------------
// extractToolCallContents: terminal items are NOT added to text accumulator
// ---------------------------------------------------------------------------

func TestExtractToolCallContents_TerminalProducesNoText(t *testing.T) {
	contents := []acpsdk.ToolCallContent{
		{
			Terminal: &acpsdk.ToolCallContentTerminal{
				TerminalId: "term-1",
			},
		},
	}
	result := extractToolCallContents(contents)
	if result != "" {
		t.Fatalf("expected empty string for terminal-only content, got %q", result)
	}
}

// Mixed content: text item + terminal item → only text accumulated.
func TestExtractToolCallContents_MixedContentAndTerminal(t *testing.T) {
	contents := []acpsdk.ToolCallContent{
		{
			Content: &acpsdk.ToolCallContentContent{
				Content: acpsdk.ContentBlock{
					Text: &acpsdk.ContentBlockText{Text: "output text"},
				},
			},
		},
		{
			Terminal: &acpsdk.ToolCallContentTerminal{
				TerminalId: "term-2",
			},
		},
	}
	result := extractToolCallContents(contents)
	if result != "output text" {
		t.Fatalf("expected 'output text', got %q", result)
	}
}

// ---------------------------------------------------------------------------
// ToolCallUpdate: skip when no content and no status (line 167 false branch)
// ---------------------------------------------------------------------------

func TestExtractMessages_ToolCallUpdate_NoContentNoStatus_Skipped(t *testing.T) {
	// An update with no status and no content should produce no message.
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
				ToolCallId: "tc-silent",
				// no Status, no Content
			},
		},
	}

	msgs := ExtractMessages(notif)
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages for update with no content/status, got %d", len(msgs))
	}
}

// ToolCallUpdate with only content (no status change) should still emit.
func TestExtractMessages_ToolCallUpdate_ContentOnly_Emitted(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
				ToolCallId: "tc-content-only",
				Content: []acpsdk.ToolCallContent{
					{
						Content: &acpsdk.ToolCallContentContent{
							Content: acpsdk.ContentBlock{
								Text: &acpsdk.ContentBlockText{Text: "progress output"},
							},
						},
					},
				},
			},
		},
	}

	msgs := ExtractMessages(notif)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message for update with content, got %d", len(msgs))
	}
	if msgs[0].Content != "progress output" {
		t.Fatalf("expected 'progress output', got %q", msgs[0].Content)
	}
}

// ---------------------------------------------------------------------------
// ToolCallUpdate: Kind pointer branch (line 154)
// ---------------------------------------------------------------------------

func TestExtractMessages_ToolCallUpdate_WithKind(t *testing.T) {
	kind := acpsdk.ToolKindEdit
	status := acpsdk.ToolCallStatusCompleted
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
				ToolCallId: "tc-with-kind",
				Kind:       &kind,
				Status:     &status,
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
	if meta.Kind != "edit" {
		t.Fatalf("expected kind=edit, got %q", meta.Kind)
	}
	if meta.Status != "completed" {
		t.Fatalf("expected status=completed, got %q", meta.Status)
	}
}

// ToolCallUpdate with no-content and status=completed uses "(tool update)" fallback.
func TestExtractMessages_ToolCallUpdate_StatusOnly_FallbackContent(t *testing.T) {
	status := acpsdk.ToolCallStatusCompleted
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
				ToolCallId: "tc-status-only",
				Status:     &status,
			},
		},
	}

	msgs := ExtractMessages(notif)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message for status-only update, got %d", len(msgs))
	}
	if msgs[0].Content != "(tool update)" {
		t.Fatalf("expected fallback content '(tool update)', got %q", msgs[0].Content)
	}
}

// ---------------------------------------------------------------------------
// Truncation applied inside marshalRawContent for diff fields
// ---------------------------------------------------------------------------

func TestMarshalRawContent_TruncatesDiffFields(t *testing.T) {
	orig := maxToolContentSize
	defer func() { maxToolContentSize = orig }()
	maxToolContentSize = 5

	oldText := "old content that is long"
	contents := []acpsdk.ToolCallContent{
		{
			Diff: &acpsdk.ToolCallContentDiff{
				Path:    "/file.go",
				OldText: &oldText,
				NewText: "new content that is also long",
			},
		},
	}

	items := marshalRawContent(contents)
	if len(items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(items))
	}
	m := unmarshalRawItem(t, items[0])

	newText, ok := m["newText"].(string)
	if !ok {
		t.Fatalf("expected newText to be string, got %T", m["newText"])
	}
	if len(newText) <= 5 {
		t.Fatalf("expected truncated newText to include marker, got %q", newText)
	}
	if newText[:5] != "new c" {
		t.Fatalf("expected newText to start with original prefix, got %q", newText)
	}

	oldTextVal, ok := m["oldText"].(string)
	if !ok {
		t.Fatalf("expected oldText to be string, got %T", m["oldText"])
	}
	if len(oldTextVal) <= 5 {
		t.Fatalf("expected truncated oldText to include marker, got %q", oldTextVal)
	}
}

// ---------------------------------------------------------------------------
// Plan: nil Plan pointer (ensure no panic)
// ---------------------------------------------------------------------------

func TestExtractMessages_Plan_NilEntries(t *testing.T) {
	// Plan with nil Entries slice (not empty, but nil) — json.Marshal treats this
	// as null, and len(nil) == 0, so no message should be emitted.
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			Plan: &acpsdk.SessionUpdatePlan{
				Entries: nil,
			},
		},
	}

	msgs := ExtractMessages(notif)
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages for nil plan entries, got %d", len(msgs))
	}
}

// ---------------------------------------------------------------------------
// marshalRawContent: empty content slice returns nil (not panic)
// ---------------------------------------------------------------------------

func TestMarshalRawContent_Empty(t *testing.T) {
	items := marshalRawContent(nil)
	if items != nil {
		t.Fatalf("expected nil for empty input, got %v", items)
	}
}

// ---------------------------------------------------------------------------
// Multiple content types in one ToolCall (mixed content + diff)
// ---------------------------------------------------------------------------

func TestExtractMessages_ToolCall_MixedContentAndDiff(t *testing.T) {
	oldText := "before"
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCall: &acpsdk.SessionUpdateToolCall{
				ToolCallId: "tc-mixed",
				Title:      "Edit with output",
				Kind:       acpsdk.ToolKindEdit,
				Content: []acpsdk.ToolCallContent{
					{
						Content: &acpsdk.ToolCallContentContent{
							Content: acpsdk.ContentBlock{
								Text: &acpsdk.ContentBlockText{Text: "applying patch"},
							},
						},
					},
					{
						Diff: &acpsdk.ToolCallContentDiff{
							Path:    "/foo.go",
							OldText: &oldText,
							NewText: "after",
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

	// extractToolCallContents should join text + diff path
	if msgs[0].Content != "applying patch\ndiff: /foo.go" {
		t.Fatalf("unexpected content: %q", msgs[0].Content)
	}

	var meta ToolMeta
	if err := json.Unmarshal([]byte(msgs[0].ToolMetadata), &meta); err != nil {
		t.Fatalf("unmarshal tool metadata: %v", err)
	}
	if len(meta.Content) != 2 {
		t.Fatalf("expected 2 structured content items, got %d", len(meta.Content))
	}
	m0 := unmarshalRawItem(t, meta.Content[0])
	if m0["type"] != "content" {
		t.Fatalf("expected first item type=content, got %v", m0["type"])
	}
	m1 := unmarshalRawItem(t, meta.Content[1])
	if m1["type"] != "diff" {
		t.Fatalf("expected second item type=diff, got %v", m1["type"])
	}
}

// ---------------------------------------------------------------------------
// extractToolCallContents: multi-text items joined with newline (line 241 branch)
// ---------------------------------------------------------------------------

func TestExtractToolCallContents_MultipleTextItems_Joined(t *testing.T) {
	// Two content items with text — the second triggers the "text != """ newline branch.
	contents := []acpsdk.ToolCallContent{
		{
			Content: &acpsdk.ToolCallContentContent{
				Content: acpsdk.ContentBlock{
					Text: &acpsdk.ContentBlockText{Text: "first"},
				},
			},
		},
		{
			Content: &acpsdk.ToolCallContentContent{
				Content: acpsdk.ContentBlock{
					Text: &acpsdk.ContentBlockText{Text: "second"},
				},
			},
		},
	}

	result := extractToolCallContents(contents)
	if result != "first\nsecond" {
		t.Fatalf("expected 'first\\nsecond', got %q", result)
	}
}

// Two diff items back to back also trigger the newline branch via the diff path.
func TestExtractToolCallContents_MultipleDiffItems_Joined(t *testing.T) {
	contents := []acpsdk.ToolCallContent{
		{
			Diff: &acpsdk.ToolCallContentDiff{Path: "/a.go", NewText: "a"},
		},
		{
			Diff: &acpsdk.ToolCallContentDiff{Path: "/b.go", NewText: "b"},
		},
	}

	result := extractToolCallContents(contents)
	if result != "diff: /a.go\ndiff: /b.go" {
		t.Fatalf("expected 'diff: /a.go\\ndiff: /b.go', got %q", result)
	}
}

// ---------------------------------------------------------------------------
// ToolCallUpdate with Locations set
// ---------------------------------------------------------------------------

func TestExtractMessages_ToolCallUpdate_WithLocations(t *testing.T) {
	status := acpsdk.ToolCallStatusCompleted
	line := 10
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
				ToolCallId: "tc-locs",
				Status:     &status,
				Locations: []acpsdk.ToolCallLocation{
					{Path: "/src/a.go", Line: &line},
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
	if len(meta.Locations) != 1 {
		t.Fatalf("expected 1 location, got %d", len(meta.Locations))
	}
	if meta.Locations[0].Path != "/src/a.go" {
		t.Fatalf("expected path=/src/a.go, got %q", meta.Locations[0].Path)
	}
	if meta.Locations[0].Line == nil || *meta.Locations[0].Line != 10 {
		t.Fatalf("expected line=10, got %v", meta.Locations[0].Line)
	}
}
