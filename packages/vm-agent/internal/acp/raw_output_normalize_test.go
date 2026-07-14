package acp

import (
	"encoding/json"
	"strings"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
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
