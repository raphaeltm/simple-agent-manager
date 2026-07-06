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

// TestExtractMessages_RawField_SizeCap verifies oversized raw payloads are
// omitted (for a library tool that IS eligible for capture) so tool metadata
// stays lean, while the tool name is still captured.
func TestExtractMessages_RawField_SizeCap(t *testing.T) {
	status := acpsdk.ToolCallStatusCompleted
	huge := strings.Repeat("x", maxToolRawFieldSize+100)
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
				ToolCallId: "tc-4",
				Status:     &status,
				Meta:       map[string]any{"claudeCode": map[string]any{"toolName": "mcp__sam-mcp__upload_to_library"}},
				RawOutput:  []any{map[string]any{"type": "text", "text": huge}},
			},
		},
	}

	meta := unmarshalMeta(t, ExtractMessages(notif))
	if meta.ToolName != "mcp__sam-mcp__upload_to_library" {
		t.Fatalf("expected toolName captured, got %q", meta.ToolName)
	}
	if meta.RawOutput != nil {
		t.Fatalf("expected oversized rawOutput to be omitted, got %d bytes", len(meta.RawOutput))
	}
}

// TestExtractMessages_RawField_ExactCap verifies a payload at exactly the cap is
// kept (the boundary is inclusive: the guard is `len > cap`).
func TestExtractMessages_RawField_ExactCap(t *testing.T) {
	// Build a JSON string value whose marshaled length is exactly the cap.
	// A JSON string is the content plus two quote bytes.
	inner := strings.Repeat("x", maxToolRawFieldSize-2)
	status := acpsdk.ToolCallStatusCompleted
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
				ToolCallId: "tc-exact",
				Status:     &status,
				Meta:       map[string]any{"claudeCode": map[string]any{"toolName": "mcp__sam-mcp__upload_to_library"}},
				RawOutput:  inner,
			},
		},
	}

	meta := unmarshalMeta(t, ExtractMessages(notif))
	if len(meta.RawOutput) != maxToolRawFieldSize {
		t.Fatalf("expected exactly-at-cap rawOutput to be kept (%d bytes), got %d", maxToolRawFieldSize, len(meta.RawOutput))
	}
}

// TestExtractMessages_RawField_NonLibraryToolNotCaptured verifies rawInput and
// rawOutput are NOT persisted for tools outside the card allowlist — Bash/Write
// arguments must not leak into persisted chat metadata (data minimization).
func TestExtractMessages_RawField_NonLibraryToolNotCaptured(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCall: &acpsdk.SessionUpdateToolCall{
				ToolCallId: "tc-bash",
				Title:      "Bash: echo secret",
				Meta:       map[string]any{"claudeCode": map[string]any{"toolName": "Bash"}},
				RawInput:   map[string]any{"command": "curl -H 'Authorization: Bearer sk-secret' https://x"},
				RawOutput:  []any{map[string]any{"type": "text", "text": "ok"}},
			},
		},
	}

	meta := unmarshalMeta(t, ExtractMessages(notif))
	if meta.ToolName != "Bash" {
		t.Fatalf("expected toolName Bash, got %q", meta.ToolName)
	}
	if meta.RawInput != nil || meta.RawOutput != nil {
		t.Fatalf("expected non-library tool raw fields to be omitted, got in=%s out=%s", meta.RawInput, meta.RawOutput)
	}
}

// TestExtractMessages_ToolName_MetaEmptyFallsToTitle verifies an empty
// _meta.claudeCode.toolName falls through to the mcp__ title convention.
func TestExtractMessages_ToolName_MetaEmptyFallsToTitle(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCall: &acpsdk.SessionUpdateToolCall{
				ToolCallId: "tc-empty",
				Title:      "mcp__sam-mcp__display_from_library",
				Meta:       map[string]any{"claudeCode": map[string]any{"toolName": ""}},
			},
		},
	}

	meta := unmarshalMeta(t, ExtractMessages(notif))
	if meta.ToolName != "mcp__sam-mcp__display_from_library" {
		t.Fatalf("expected title fallback when claudeCode.toolName empty, got %q", meta.ToolName)
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

// TestExtractMessages_ToolName_CodexSlashTitle verifies the Codex
// `<server>/<tool>` title convention is recognized (no _meta.claudeCode) and
// that the library tool's raw input is captured for card rendering. This is the
// regression that broke DocumentCard rendering for Codex sessions.
func TestExtractMessages_ToolName_CodexSlashTitle(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCall: &acpsdk.SessionUpdateToolCall{
				ToolCallId: "tc-codex",
				Title:      "sam-mcp/display_from_library",
				RawInput:   map[string]any{"fileId": "01KWV7J5N2Q1AGFTMQSNK1RE7B", "caption": "render test"},
			},
		},
	}

	meta := unmarshalMeta(t, ExtractMessages(notif))
	if meta.ToolName != "sam-mcp/display_from_library" {
		t.Fatalf("expected Codex slash title captured as toolName, got %q", meta.ToolName)
	}
	if meta.RawInput == nil {
		t.Fatalf("expected rawInput captured for Codex library tool, got nil")
	}
	var input map[string]any
	if err := json.Unmarshal(meta.RawInput, &input); err != nil {
		t.Fatalf("unmarshal rawInput: %v", err)
	}
	if input["fileId"] != "01KWV7J5N2Q1AGFTMQSNK1RE7B" {
		t.Fatalf("expected rawInput.fileId preserved, got %v", input["fileId"])
	}
}

// TestExtractMessages_ToolCallUpdate_CodexSlash verifies the Codex result update
// (slash title, no _meta) captures the tool name and rawOutput payload.
func TestExtractMessages_ToolCallUpdate_CodexSlash(t *testing.T) {
	status := acpsdk.ToolCallStatusCompleted
	title := "sam-mcp/display_from_library"
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
				ToolCallId: "tc-codex",
				Status:     &status,
				Title:      &title,
				RawOutput: []any{
					map[string]any{"type": "text", "text": `{"fileId":"f-9","filename":"arch.html","mimeType":"text/html","sizeBytes":15357}`},
				},
			},
		},
	}

	meta := unmarshalMeta(t, ExtractMessages(notif))
	if meta.ToolName != "sam-mcp/display_from_library" {
		t.Fatalf("expected Codex slash toolName on update, got %q", meta.ToolName)
	}
	if meta.RawOutput == nil {
		t.Fatalf("expected rawOutput captured for Codex library update, got nil")
	}
}

// TestExtractMessages_ToolName_CodexNonLibrarySlash verifies a Codex slash title
// for a NON-library tool is not claimed as a toolName (no card, no raw capture).
func TestExtractMessages_ToolName_CodexNonLibrarySlash(t *testing.T) {
	notif := acpsdk.SessionNotification{
		SessionId: "sess-1",
		Update: acpsdk.SessionUpdate{
			ToolCall: &acpsdk.SessionUpdateToolCall{
				ToolCallId: "tc-codex-list",
				Title:      "sam-mcp/list_library_files",
				RawInput:   map[string]any{"directory": "/docs/"},
			},
		},
	}

	meta := unmarshalMeta(t, ExtractMessages(notif))
	if meta.ToolName != "" {
		t.Fatalf("expected non-library Codex slash tool to yield no toolName, got %q", meta.ToolName)
	}
	if meta.RawInput != nil {
		t.Fatalf("expected no raw capture for non-library tool, got %s", meta.RawInput)
	}
}

// TestNormalizeToolNameBase covers the delimiter-agnostic normalizer across
// every adapter separator convention plus the capture gate that keys on it.
func TestNormalizeToolNameBase(t *testing.T) {
	cases := []struct {
		in            string
		want          string
		wantRawCapture bool
	}{
		{"mcp__sam-mcp__display_from_library", "display_from_library", true},
		{"sam-mcp/display_from_library", "display_from_library", true},
		{"sam-mcp-1/replace_library_file", "replace_library_file", true},
		{"sam-mcp.upload_to_library", "upload_to_library", true},
		{"sam-mcp:display_from_library", "display_from_library", true},
		{"display_from_library", "display_from_library", true},
		{"Read", "Read", false},
		{"Bash", "Bash", false},
		{"sam-mcp/list_library_files", "list_library_files", false},
		{"", "", false},
	}
	for _, c := range cases {
		if got := normalizeToolNameBase(c.in); got != c.want {
			t.Errorf("normalizeToolNameBase(%q) = %q, want %q", c.in, got, c.want)
		}
		if got := toolNameNeedsRawCapture(c.in); got != c.wantRawCapture {
			t.Errorf("toolNameNeedsRawCapture(%q) = %v, want %v", c.in, got, c.wantRawCapture)
		}
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
