package agent

import (
	"context"
	"sync"
	"testing"

	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/tools"
	"github.com/workspace/harness/transcript"
)

// testHandler records streaming events for assertions.
type testHandler struct {
	mu         sync.Mutex
	tokens     []string
	toolStarts []string
	toolEnds   []string
	turnStarts []int
	turnEnds   []int
}

func (h *testHandler) OnToken(token string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.tokens = append(h.tokens, token)
}
func (h *testHandler) OnToolStart(_ string, name string, _ map[string]any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.toolStarts = append(h.toolStarts, name)
}
func (h *testHandler) OnToolEnd(_ string, name string, _ string, _ bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.toolEnds = append(h.toolEnds, name)
}
func (h *testHandler) OnTurnStart(turn, _ int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.turnStarts = append(h.turnStarts, turn)
}
func (h *testHandler) OnTurnEnd(turn int, _ int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.turnEnds = append(h.turnEnds, turn)
}

func TestRun_Streaming_NoToolCalls(t *testing.T) {
	provider := llm.NewMockStreamProvider(
		&llm.Response{Content: "Hello from streaming!"},
	)
	registry := tools.NewRegistry()
	log := transcript.NewLog()
	handler := &testHandler{}

	result, err := Run(context.Background(), provider, registry, log, Config{
		MaxTurns: 5,
		Stream:   true,
		Handler:  handler,
	}, "Say hello")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %q, want %q", result.StopReason, "complete")
	}
	if result.FinalMessage != "Hello from streaming!" {
		t.Errorf("final_message = %q, want %q", result.FinalMessage, "Hello from streaming!")
	}

	// Handler should have received token events.
	handler.mu.Lock()
	tokenCount := len(handler.tokens)
	handler.mu.Unlock()
	if tokenCount == 0 {
		t.Error("expected token events from handler, got none")
	}

	// Turn events should have fired.
	handler.mu.Lock()
	defer handler.mu.Unlock()
	if len(handler.turnStarts) != 1 {
		t.Errorf("turn starts = %d, want 1", len(handler.turnStarts))
	}
	if len(handler.turnEnds) != 1 {
		t.Errorf("turn ends = %d, want 1", len(handler.turnEnds))
	}
}

func TestRun_Streaming_WithToolCalls(t *testing.T) {
	provider := llm.NewMockStreamProvider(
		// Turn 1: model calls a tool.
		&llm.Response{
			Content: "Let me check.",
			ToolCalls: []llm.ToolCall{
				{ID: "c1", Name: "echo", Params: map[string]any{"text": "hi"}},
			},
		},
		// Turn 2: model completes.
		&llm.Response{Content: "Done!"},
	)

	registry := tools.NewRegistry()
	_ = registry.Register(&echoTool{})
	log := transcript.NewLog()
	handler := &testHandler{}

	result, err := Run(context.Background(), provider, registry, log, Config{
		MaxTurns: 5,
		Stream:   true,
		Handler:  handler,
	}, "Test streaming with tools")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %q, want %q", result.StopReason, "complete")
	}
	if result.TurnsUsed != 2 {
		t.Errorf("turns_used = %d, want 2", result.TurnsUsed)
	}

	handler.mu.Lock()
	defer handler.mu.Unlock()
	if len(handler.toolStarts) != 1 || handler.toolStarts[0] != "echo" {
		t.Errorf("tool starts = %v, want [echo]", handler.toolStarts)
	}
	if len(handler.toolEnds) != 1 || handler.toolEnds[0] != "echo" {
		t.Errorf("tool ends = %v, want [echo]", handler.toolEnds)
	}
}

func TestRun_Streaming_FallsBackWhenNotSupported(t *testing.T) {
	// Regular MockProvider does NOT implement StreamProvider.
	provider := llm.NewMockProvider(
		&llm.Response{Content: "Non-streaming response"},
	)
	registry := tools.NewRegistry()
	log := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, log, Config{
		MaxTurns: 5,
		Stream:   true, // requested but provider doesn't support it
	}, "Test fallback")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.FinalMessage != "Non-streaming response" {
		t.Errorf("final_message = %q, want %q", result.FinalMessage, "Non-streaming response")
	}
}

// echoTool is defined in loop_test.go — reused here.
