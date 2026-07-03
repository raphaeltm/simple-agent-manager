package acp

import (
	"encoding/json"
	"strings"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
)

// unmarshalMeta is a small helper that parses the ToolMetadata JSON of the
// single extracted message, failing the test on any deviation.
func unmarshalMeta(t *testing.T, msgs []ExtractedMessage) ToolMeta {
	t.Helper()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	var meta ToolMeta
	if err := json.Unmarshal([]byte(msgs[0].ToolMetadata), &meta); err != nil {
		t.Fatalf("unmarshal tool metadata: %v", err)
	}
	return meta
}

// TestExtractMessages_ToolName_FromMeta verifies the stable tool name and the
// raw input are captured from the initial tool_call's _meta.claudeCode
// extension — the primary discriminator source for typed tool-call cards.
func TestExtractMessages_ToolName_FromMeta(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCall: &acpsdk.SessionUpdateToolCall{
				ToolCallId: "tc-1",
				Title:      "Upload document to library",
				Meta: map[string]any{
					"claudeCode": map[string]any{"toolName": "mcp__sam-mcp__upload_to_library"},
				},
				RawInput: map[string]any{"filePath": "/tmp/auth-explainer.md", "directory": "/docs/"},
			},
		},
	}

	meta := unmarshalMeta(t, ExtractMessages(notif))
	if meta.ToolName != "mcp__sam-mcp__upload_to_library" {
		t.Fatalf("expected toolName from _meta, got %q", meta.ToolName)
	}
	var input map[string]any
	if err := json.Unmarshal(meta.RawInput, &input); err != nil {
		t.Fatalf("unmarshal rawInput: %v", err)
	}
	if input["filePath"] != "/tmp/auth-explainer.md" {
		t.Fatalf("expected rawInput.filePath preserved, got %v", input["filePath"])
	}
}

// TestExtractMessages_ToolCallUpdate_ToolNameAndRawOutput verifies the result
// tool_call_update carries the tool name and the MCP result payload (rawOutput),
// which is where the card reads fileId/filename/mimeType/sizeBytes from.
func TestExtractMessages_ToolCallUpdate_ToolNameAndRawOutput(t *testing.T) {
	status := acpsdk.ToolCallStatusCompleted
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
				ToolCallId: "tc-1",
				Status:     &status,
				Meta: map[string]any{
					"claudeCode": map[string]any{"toolName": "mcp__sam-mcp__upload_to_library"},
				},
				// The adapter sets rawOutput to the MCP content array.
				RawOutput: []any{
					map[string]any{"type": "text", "text": `{"fileId":"f-1","filename":"auth.md","mimeType":"text/markdown","sizeBytes":1234}`},
				},
			},
		},
	}

	meta := unmarshalMeta(t, ExtractMessages(notif))
	if meta.ToolName != "mcp__sam-mcp__upload_to_library" {
		t.Fatalf("expected toolName on update, got %q", meta.ToolName)
	}
	var output []map[string]any
	if err := json.Unmarshal(meta.RawOutput, &output); err != nil {
		t.Fatalf("unmarshal rawOutput: %v", err)
	}
	if len(output) != 1 || output[0]["type"] != "text" {
		t.Fatalf("expected rawOutput text block, got %v", output)
	}
}

// TestExtractMessages_ToolName_TitleFallback verifies the mcp__<server>__<tool>
// title convention is recognized when the _meta extension is absent (non-Claude
// adapters).
func TestExtractMessages_ToolName_TitleFallback(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCall: &acpsdk.SessionUpdateToolCall{
				ToolCallId: "tc-2",
				Title:      "mcp__sam-mcp__display_from_library",
			},
		},
	}

	meta := unmarshalMeta(t, ExtractMessages(notif))
	if meta.ToolName != "mcp__sam-mcp__display_from_library" {
		t.Fatalf("expected toolName from title fallback, got %q", meta.ToolName)
	}
}

// TestExtractMessages_ToolName_NoSource verifies a plain built-in tool with no
// _meta and a human title yields no toolName (cards fall back to generic).
func TestExtractMessages_ToolName_NoSource(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCall: &acpsdk.SessionUpdateToolCall{
				ToolCallId: "tc-3",
				Title:      "Read file /src/main.go",
				Kind:       acpsdk.ToolKindRead,
			},
		},
	}

	meta := unmarshalMeta(t, ExtractMessages(notif))
	if meta.ToolName != "" {
		t.Fatalf("expected empty toolName for built-in tool, got %q", meta.ToolName)
	}
}

// TestExtractMessages_RawField_SizeCap verifies oversized raw payloads (file
// contents, command output) are omitted so tool metadata stays lean, while the
// tool name is still captured.
func TestExtractMessages_RawField_SizeCap(t *testing.T) {
	status := acpsdk.ToolCallStatusCompleted
	huge := strings.Repeat("x", maxToolRawFieldSize+100)
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
				ToolCallId: "tc-4",
				Status:     &status,
				Meta:       map[string]any{"claudeCode": map[string]any{"toolName": "Read"}},
				RawOutput:  []any{map[string]any{"type": "text", "text": huge}},
			},
		},
	}

	meta := unmarshalMeta(t, ExtractMessages(notif))
	if meta.ToolName != "Read" {
		t.Fatalf("expected toolName captured, got %q", meta.ToolName)
	}
	if meta.RawOutput != nil {
		t.Fatalf("expected oversized rawOutput to be omitted, got %d bytes", len(meta.RawOutput))
	}
}

// TestExtractMessages_RawField_NilOmitted verifies absent raw fields are omitted
// entirely (not serialized as null), keeping the metadata compact.
func TestExtractMessages_RawField_NilOmitted(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCall: &acpsdk.SessionUpdateToolCall{
				ToolCallId: "tc-5",
				Title:      "mcp__sam-mcp__display_from_library",
			},
		},
	}

	meta := unmarshalMeta(t, ExtractMessages(notif))
	if meta.RawInput != nil || meta.RawOutput != nil {
		t.Fatalf("expected nil raw fields when absent, got in=%v out=%v", meta.RawInput, meta.RawOutput)
	}
	if !strings.Contains(msgsMeta(t, notif), "display_from_library") {
		t.Fatalf("expected toolName in serialized metadata")
	}
}

// msgsMeta returns the serialized ToolMetadata string of the single extracted
// message, for substring assertions on the exact wire format.
func msgsMeta(t *testing.T, notif acpsdk.SessionNotification) string {
	t.Helper()
	msgs := ExtractMessages(notif)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	return msgs[0].ToolMetadata
}
