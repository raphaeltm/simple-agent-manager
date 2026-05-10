package llm

import (
	"testing"
)

func TestCollectStream_TextOnly(t *testing.T) {
	ch := make(chan StreamEvent, 10)
	ch <- StreamEvent{Type: EventContentDelta, Delta: "Hello "}
	ch <- StreamEvent{Type: EventContentDelta, Delta: "world"}
	ch <- StreamEvent{Type: EventDone, Usage: &Usage{PromptTokens: 10, CompletionTokens: 5, TotalTokens: 15}}
	close(ch)

	resp, err := CollectStream(ch)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Content != "Hello world" {
		t.Errorf("content = %q, want %q", resp.Content, "Hello world")
	}
	if len(resp.ToolCalls) != 0 {
		t.Errorf("tool calls = %d, want 0", len(resp.ToolCalls))
	}
	if resp.StopReason != "end_turn" {
		t.Errorf("stop_reason = %q, want %q", resp.StopReason, "end_turn")
	}
	if resp.Usage == nil || resp.Usage.TotalTokens != 15 {
		t.Errorf("usage.TotalTokens = %v, want 15", resp.Usage)
	}
}

func TestCollectStream_WithToolCalls(t *testing.T) {
	ch := make(chan StreamEvent, 20)
	ch <- StreamEvent{Type: EventContentDelta, Delta: "Let me read that file."}
	ch <- StreamEvent{
		Type: EventToolCallStart,
		ToolCall: &ToolCallDelta{
			Index: 0,
			ID:    "call_1",
			Name:  "read_file",
		},
	}
	ch <- StreamEvent{
		Type: EventToolCallDelta,
		ToolCall: &ToolCallDelta{
			Index:          0,
			ArgumentsDelta: `{"path":`,
		},
	}
	ch <- StreamEvent{
		Type: EventToolCallDelta,
		ToolCall: &ToolCallDelta{
			Index:          0,
			ArgumentsDelta: `"main.go"}`,
		},
	}
	ch <- StreamEvent{Type: EventDone}
	close(ch)

	resp, err := CollectStream(ch)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Content != "Let me read that file." {
		t.Errorf("content = %q, want %q", resp.Content, "Let me read that file.")
	}
	if len(resp.ToolCalls) != 1 {
		t.Fatalf("tool calls = %d, want 1", len(resp.ToolCalls))
	}
	tc := resp.ToolCalls[0]
	if tc.ID != "call_1" || tc.Name != "read_file" {
		t.Errorf("tool call = %+v, want ID=call_1, Name=read_file", tc)
	}
	if tc.Params["path"] != "main.go" {
		t.Errorf("params[path] = %v, want main.go", tc.Params["path"])
	}
	if resp.StopReason != "tool_use" {
		t.Errorf("stop_reason = %q, want %q", resp.StopReason, "tool_use")
	}
}

func TestCollectStream_Error(t *testing.T) {
	ch := make(chan StreamEvent, 5)
	ch <- StreamEvent{Type: EventContentDelta, Delta: "partial"}
	ch <- StreamEvent{Type: EventError, Error: errTest}
	close(ch)

	_, err := CollectStream(ch)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if err != errTest {
		t.Errorf("error = %v, want %v", err, errTest)
	}
}

var errTest = &testError{msg: "test stream error"}

type testError struct{ msg string }

func (e *testError) Error() string { return e.msg }
