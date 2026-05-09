package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/tools"
	"github.com/workspace/harness/transcript"
)

func TestRun_NoToolCalls(t *testing.T) {
	provider := llm.NewMockProvider(
		&llm.Response{Content: "The answer is 42."},
	)
	registry := tools.NewRegistry()
	log := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, log, Config{
		MaxTurns: 5,
	}, "What is the meaning of life?")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}
	if result.TurnsUsed != 1 {
		t.Errorf("turns_used = %d, want 1", result.TurnsUsed)
	}
	if result.FinalMessage != "The answer is 42." {
		t.Errorf("final_message = %q, want %q", result.FinalMessage, "The answer is 42.")
	}
}

func TestRun_ToolCallThenComplete(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "test.txt"), []byte("hello world"), 0o644)

	provider := llm.NewMockProvider(
		// Turn 1: ask to read a file
		&llm.Response{
			Content: "Let me read the file.",
			ToolCalls: []llm.ToolCall{{
				ID:     "call-1",
				Name:   "read_file",
				Params: map[string]any{"path": "test.txt"},
			}},
		},
		// Turn 2: respond with summary
		&llm.Response{Content: "The file contains 'hello world'."},
	)

	registry := tools.NewRegistry()
	registry.Register(&tools.ReadFile{WorkDir: dir})

	log := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, log, Config{
		MaxTurns: 5,
	}, "Read test.txt")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}
	if result.TurnsUsed != 2 {
		t.Errorf("turns_used = %d, want 2", result.TurnsUsed)
	}
	if result.FinalMessage != "The file contains 'hello world'." {
		t.Errorf("final_message = %q", result.FinalMessage)
	}

	// Verify transcript recorded events.
	events := log.Events()
	if len(events) == 0 {
		t.Fatal("no transcript events recorded")
	}

	// Should have: LLMRequest(1), LLMResponse(1), ToolCall(1), ToolResult(1), LLMRequest(2), LLMResponse(2)
	types := make([]transcript.EventType, len(events))
	for i, e := range events {
		types[i] = e.Type
	}
	expected := []transcript.EventType{
		transcript.EventLLMRequest, transcript.EventLLMResponse,
		transcript.EventToolCall, transcript.EventToolResult,
		transcript.EventLLMRequest, transcript.EventLLMResponse,
	}
	if len(types) != len(expected) {
		t.Fatalf("got %d events, want %d: %v", len(types), len(expected), types)
	}
	for i, exp := range expected {
		if types[i] != exp {
			t.Errorf("event %d: got %s, want %s", i, types[i], exp)
		}
	}
}

func TestRun_MaxTurns(t *testing.T) {
	// Provider always returns tool calls, never stops.
	responses := make([]*llm.Response, 5)
	for i := range responses {
		responses[i] = &llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "call",
				Name:   "echo",
				Params: map[string]any{"text": "loop"},
			}},
		}
	}
	provider := llm.NewMockProvider(responses...)

	registry := tools.NewRegistry()
	registry.Register(&echoTool{})

	log := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, log, Config{
		MaxTurns: 3,
	}, "loop forever")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.StopReason != "max_turns" {
		t.Errorf("stop_reason = %s, want max_turns", result.StopReason)
	}
	if result.TurnsUsed != 3 {
		t.Errorf("turns_used = %d, want 3", result.TurnsUsed)
	}
}

func TestRun_Cancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	provider := llm.NewMockProvider(&llm.Response{Content: "never reached"})
	registry := tools.NewRegistry()
	log := transcript.NewLog()

	result, err := Run(ctx, provider, registry, log, Config{}, "test")
	if err == nil {
		t.Fatal("expected error on cancelled context")
	}
	if result.StopReason != "cancelled" {
		t.Errorf("stop_reason = %s, want cancelled", result.StopReason)
	}
}

func TestRun_ScriptedEditWorkflow(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "app.py"), []byte("print('hello')"), 0o644)

	provider := llm.NewMockProvider(
		// Turn 1: read the file
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c1",
				Name:   "read_file",
				Params: map[string]any{"path": "app.py"},
			}},
		},
		// Turn 2: edit the file
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:   "c2",
				Name: "edit_file",
				Params: map[string]any{
					"path":       "app.py",
					"old_string": "print('hello')",
					"new_string": "print('goodbye')",
				},
			}},
		},
		// Turn 3: verify with bash
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c3",
				Name:   "bash",
				Params: map[string]any{"command": "cat app.py"},
			}},
		},
		// Turn 4: done
		&llm.Response{Content: "File has been updated to print goodbye."},
	)

	registry := tools.NewRegistry()
	registry.Register(&tools.ReadFile{WorkDir: dir})
	registry.Register(&tools.EditFile{WorkDir: dir})
	registry.Register(&tools.Bash{WorkDir: dir})

	log := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, log, Config{
		MaxTurns: 10,
	}, "Change hello to goodbye in app.py")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}
	if result.TurnsUsed != 4 {
		t.Errorf("turns_used = %d, want 4", result.TurnsUsed)
	}

	// Verify the file was actually edited.
	data, _ := os.ReadFile(filepath.Join(dir, "app.py"))
	if !strings.Contains(string(data), "goodbye") {
		t.Error("file was not edited")
	}
}

func TestRun_CompactionTriggered(t *testing.T) {
	// Create a provider that always returns tool calls with large content,
	// eventually stopping. We set a very low context limit to force compaction.
	numTurns := 8
	responses := make([]*llm.Response, numTurns)
	for i := 0; i < numTurns-1; i++ {
		responses[i] = &llm.Response{
			Content: strings.Repeat("thinking deeply about this problem ", 20),
			ToolCalls: []llm.ToolCall{{
				ID:     fmt.Sprintf("call-%d", i),
				Name:   "echo",
				Params: map[string]any{"text": strings.Repeat("verbose output ", 30)},
			}},
		}
	}
	// Last turn: no tool calls, agent finishes.
	responses[numTurns-1] = &llm.Response{Content: "Done."}

	provider := llm.NewMockProvider(responses...)
	registry := tools.NewRegistry()
	registry.Register(&echoTool{})
	tlog := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, tlog, Config{
		SystemPrompt:     "You are a test assistant.",
		MaxTurns:         numTurns,
		MaxContextTokens: 500, // Very low to trigger compaction.
	}, "Do something verbose.")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}

	// Check that compaction events were logged.
	var compactionCount int
	for _, e := range tlog.Events() {
		if e.Type == transcript.EventInfo {
			if data, ok := e.Data.(map[string]any); ok {
				if data["event"] == "compaction" {
					compactionCount++
					if _, ok := data["messages_removed"]; !ok {
						t.Error("compaction event missing messages_removed")
					}
					if _, ok := data["tokens_before"]; !ok {
						t.Error("compaction event missing tokens_before")
					}
					if _, ok := data["tokens_after"]; !ok {
						t.Error("compaction event missing tokens_after")
					}
				}
			}
		}
	}
	if compactionCount == 0 {
		t.Error("expected at least one compaction event in transcript")
	}
}

func TestRun_NoCompactionWhenUnderLimit(t *testing.T) {
	provider := llm.NewMockProvider(
		&llm.Response{Content: "Short answer."},
	)
	registry := tools.NewRegistry()
	tlog := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, tlog, Config{
		MaxTurns:         5,
		MaxContextTokens: 100000, // Very high, no compaction needed.
	}, "Hi")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}

	// No compaction events should appear.
	for _, e := range tlog.Events() {
		if e.Type == transcript.EventInfo {
			if data, ok := e.Data.(map[string]any); ok {
				if data["event"] == "compaction" {
					t.Error("unexpected compaction event when under limit")
				}
			}
		}
	}
}

// echoTool for testing max_turns
type echoTool struct{}

func (e *echoTool) Name() string        { return "echo" }
func (e *echoTool) Description() string { return "echo" }
func (e *echoTool) Schema() map[string]any {
	return map[string]any{"type": "object", "properties": map[string]any{"text": map[string]any{"type": "string"}}}
}
func (e *echoTool) Execute(_ context.Context, params map[string]any) (string, error) {
	return "echoed", nil
}
