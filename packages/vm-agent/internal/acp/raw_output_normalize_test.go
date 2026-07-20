package acp

import (
	"encoding/json"
	"strings"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
	"unicode/utf8"
)

func TestExtractMessages_Codex112CommandRawOutput(t *testing.T) {
	status := acpsdk.ToolCallStatusCompleted
	msgs := ExtractMessages(acpsdk.SessionNotification{Update: acpsdk.SessionUpdate{
		ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
			ToolCallId: "command-1",
			Status:     &status,
			RawInput:   map[string]any{"command": "printf secret-command-argument"},
			RawOutput: map[string]any{
				"formatted_output": "SAM_COMMAND_OUTPUT_112\n",
				"exit_code":        7,
			},
		},
	}})
	meta := unmarshalMeta(t, msgs)
	if msgs[0].Content != "SAM_COMMAND_OUTPUT_112\n" {
		t.Fatalf("expected command output, got %q", msgs[0].Content)
	}
	if len(meta.Content) != 1 || len(meta.RawInput) != 0 || len(meta.RawOutput) != 0 {
		t.Fatalf("expected normalized content without generic raw fields: %+v", meta)
	}
	var item map[string]any
	if err := json.Unmarshal(meta.Content[0], &item); err != nil {
		t.Fatal(err)
	}
	if item["type"] != "terminal" || item["exitCode"] != float64(7) {
		t.Fatalf("expected terminal content with exit code, got %v", item)
	}
	if strings.Contains(msgs[0].ToolMetadata, "secret-command-argument") {
		t.Fatal("raw command input leaked into durable metadata")
	}
}

func TestExtractMessages_Codex112MCPResultAndSparseCorrelation(t *testing.T) {
	status := acpsdk.ToolCallStatusCompleted
	msgs := ExtractMessages(acpsdk.SessionNotification{Update: acpsdk.SessionUpdate{
		ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
			ToolCallId: "mcp-1",
			Status:     &status,
			RawOutput: map[string]any{"result": []any{
				map[string]any{"type": "text", "text": "SAM_MCP_OUTPUT_112"},
			}},
		},
	}})
	meta := unmarshalMeta(t, msgs)
	if meta.ToolCallId != "mcp-1" || meta.Title != "" || meta.ToolName != "" {
		t.Fatalf("sparse update must correlate only by toolCallId: %+v", meta)
	}
	if msgs[0].Content != "SAM_MCP_OUTPUT_112" || len(meta.Content) != 1 {
		t.Fatalf("expected normalized MCP result, got %+v", msgs[0])
	}
}

func TestExtractMessages_Codex112MCPError(t *testing.T) {
	status := acpsdk.ToolCallStatusFailed
	msgs := ExtractMessages(acpsdk.SessionNotification{Update: acpsdk.SessionUpdate{
		ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
			ToolCallId: "mcp-error-1",
			Status:     &status,
			RawOutput:  map[string]any{"error": map[string]any{"message": "SAM_MCP_ERROR_112"}},
		},
	}})
	if msgs[0].Content != "Error: SAM_MCP_ERROR_112" {
		t.Fatalf("expected normalized MCP error, got %q", msgs[0].Content)
	}
}

func TestExtractMessages_UnknownRawOutputIsNotPersisted(t *testing.T) {
	status := acpsdk.ToolCallStatusCompleted
	msgs := ExtractMessages(acpsdk.SessionNotification{Update: acpsdk.SessionUpdate{
		ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
			ToolCallId: "unknown-1",
			Status:     &status,
			RawInput:   map[string]any{"token": "do-not-store"},
			RawOutput:  map[string]any{"credential": "do-not-store"},
		},
	}})
	meta := unmarshalMeta(t, msgs)
	if len(meta.Content) != 0 || len(meta.RawInput) != 0 || len(meta.RawOutput) != 0 {
		t.Fatalf("unknown raw fields must remain excluded: %+v", meta)
	}
	if msgs[0].Content != "(tool update)" {
		t.Fatalf("unknown shape should retain placeholder behavior, got %q", msgs[0].Content)
	}
}

func TestExtractMessages_StructuredContentWinsOverRawFallback(t *testing.T) {
	status := acpsdk.ToolCallStatusCompleted
	msgs := ExtractMessages(acpsdk.SessionNotification{Update: acpsdk.SessionUpdate{
		ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
			ToolCallId: "structured-1",
			Status:     &status,
			Content: []acpsdk.ToolCallContent{{Content: &acpsdk.ToolCallContentContent{
				Content: acpsdk.ContentBlock{Text: &acpsdk.ContentBlockText{Text: "structured-wins"}},
			}}},
			RawOutput: map[string]any{"formatted_output": "fallback-loses", "exit_code": 0},
		},
	}})
	meta := unmarshalMeta(t, msgs)
	if msgs[0].Content != "structured-wins" || len(meta.Content) != 1 {
		t.Fatalf("existing ACP content must win: %+v", msgs[0])
	}
	if strings.Contains(string(meta.Content[0]), "fallback-loses") {
		t.Fatal("raw fallback replaced structured ACP content")
	}
}

func TestExtractMessages_TerminalReferencePreservedWithRawCommandOutput(t *testing.T) {
	status := acpsdk.ToolCallStatusCompleted
	msgs := ExtractMessages(acpsdk.SessionNotification{Update: acpsdk.SessionUpdate{
		ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
			ToolCallId: "terminal-reference-1",
			Status:     &status,
			Content: []acpsdk.ToolCallContent{{Terminal: &acpsdk.ToolCallContentTerminal{
				TerminalId: "term-1",
			}}},
			RawOutput: map[string]any{"formatted_output": "terminal output survives", "exit_code": 0},
		},
	}})
	meta := unmarshalMeta(t, msgs)
	if msgs[0].Content != "terminal output survives" {
		t.Fatalf("expected raw command output, got %q", msgs[0].Content)
	}
	if len(meta.Content) != 2 {
		t.Fatalf("expected terminal reference plus normalized output, got %d items", len(meta.Content))
	}
	if !strings.Contains(string(meta.Content[0]), "term-1") || !strings.Contains(string(meta.Content[1]), "terminal output survives") {
		t.Fatalf("expected both structured terminal reference and normalized output: %s / %s", meta.Content[0], meta.Content[1])
	}
}

func TestExtractMessages_MCPTraversalIsBoundedBeforeSerialization(t *testing.T) {
	status := acpsdk.ToolCallStatusCompleted
	large := strings.Repeat("界", maxToolContentSize)
	cycle := map[string]any{}
	cycle["content"] = cycle
	msgs := ExtractMessages(acpsdk.SessionNotification{Update: acpsdk.SessionUpdate{
		ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
			ToolCallId: "bounded-mcp-1",
			Status:     &status,
			RawOutput: map[string]any{"result": []any{
				map[string]any{"credential": strings.Repeat("secret", maxToolContentSize)},
				cycle,
				map[string]any{"text": large},
				map[string]any{"text": "must-not-overflow-budget"},
			}},
		},
	}})
	meta := unmarshalMeta(t, msgs)
	if len(msgs[0].Content) > maxToolContentSize {
		t.Fatalf("normalized content exceeded budget: %d", len(msgs[0].Content))
	}
	if !utf8.ValidString(msgs[0].Content) {
		t.Fatal("bounded MCP output is not valid UTF-8")
	}
	if strings.Contains(msgs[0].Content, "secret") || strings.Contains(msgs[0].Content, "must-not-overflow-budget") {
		t.Fatal("unknown or over-budget fields leaked into normalized content")
	}
	if len(meta.Content) != 1 || len(meta.RawOutput) != 0 {
		t.Fatalf("expected one bounded content item and no rawOutput: %+v", meta)
	}
}

func TestExtractMessages_MCPUnknownObjectIsUsefulAndRedacted(t *testing.T) {
	status := acpsdk.ToolCallStatusCompleted
	msgs := ExtractMessages(acpsdk.SessionNotification{Update: acpsdk.SessionUpdate{
		ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
			ToolCallId: "object-mcp-1",
			Status:     &status,
			RawOutput: map[string]any{"result": map[string]any{
				"count":   3,
				"items":   []any{map[string]any{"name": "alpha"}},
				"token":   "bearer-secret",
				"command": "cat /private/file",
			}},
		},
	}})
	content := msgs[0].Content
	for _, expected := range []string{"count: 3", "name: alpha", "[redacted]"} {
		if !strings.Contains(content, expected) {
			t.Fatalf("expected %q in normalized MCP object: %s", expected, content)
		}
	}
	for _, forbidden := range []string{"bearer-secret", "cat /private/file"} {
		if strings.Contains(content, forbidden) {
			t.Fatalf("sensitive value %q leaked: %s", forbidden, content)
		}
	}
}
