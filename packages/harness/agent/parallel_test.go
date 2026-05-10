package agent

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/tools"
	"github.com/workspace/harness/transcript"
)

// slowTool is a tool that sleeps for a duration, used to verify parallel execution.
type slowTool struct {
	duration time.Duration
	counter  *atomic.Int32
	maxConc  *atomic.Int32
}

func (s *slowTool) Name() string        { return "slow_tool" }
func (s *slowTool) Description() string  { return "A slow tool for testing" }
func (s *slowTool) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"id": map[string]any{"type": "string"},
		},
	}
}
func (s *slowTool) Execute(_ context.Context, params map[string]any) (string, error) {
	cur := s.counter.Add(1)
	// Track max concurrency observed.
	for {
		old := s.maxConc.Load()
		if cur <= old || s.maxConc.CompareAndSwap(old, cur) {
			break
		}
	}
	time.Sleep(s.duration)
	s.counter.Add(-1)
	id, _ := params["id"].(string)
	return "done:" + id, nil
}

// panicTool panics when executed.
type panicTool struct{}

func (p *panicTool) Name() string        { return "panic_tool" }
func (p *panicTool) Description() string  { return "A tool that panics" }
func (p *panicTool) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"msg": map[string]any{"type": "string"},
		},
	}
}
func (p *panicTool) Execute(_ context.Context, params map[string]any) (string, error) {
	panic(params["msg"])
}

func TestParallel_OrderPreserved(t *testing.T) {
	counter := &atomic.Int32{}
	maxConc := &atomic.Int32{}
	st := &slowTool{duration: 50 * time.Millisecond, counter: counter, maxConc: maxConc}

	registry := tools.NewRegistry()
	registry.Register(st)

	provider := llm.NewMockProvider(
		&llm.Response{
			Content: "Running tools",
			ToolCalls: []llm.ToolCall{
				{ID: "c1", Name: "slow_tool", Params: map[string]any{"id": "first"}},
				{ID: "c2", Name: "slow_tool", Params: map[string]any{"id": "second"}},
				{ID: "c3", Name: "slow_tool", Params: map[string]any{"id": "third"}},
			},
		},
		&llm.Response{Content: "All done."},
	)

	log := transcript.NewLog()
	start := time.Now()
	result, err := Run(context.Background(), provider, registry, log, Config{
		MaxTurns:      5,
		ParallelTools: true,
	}, "run them")

	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}

	// Parallel execution should finish in ~50ms, not ~150ms.
	if elapsed > 120*time.Millisecond {
		t.Errorf("elapsed %v suggests sequential execution, expected parallel", elapsed)
	}

	// Verify results were delivered in original order by checking the second LLM call's messages.
	// The mock provider stores messages from the second call.
	msgs := provider.CallMessages(1)
	// Find tool result messages.
	var toolResults []string
	for _, m := range msgs {
		if m.Role == llm.RoleTool && m.ToolResult != nil {
			toolResults = append(toolResults, m.ToolResult.Content)
		}
	}
	if len(toolResults) != 3 {
		t.Fatalf("expected 3 tool results, got %d", len(toolResults))
	}
	expected := []string{"done:first", "done:second", "done:third"}
	for i, want := range expected {
		if toolResults[i] != want {
			t.Errorf("tool result[%d] = %q, want %q", i, toolResults[i], want)
		}
	}
}

func TestParallel_DisabledUsesSequential(t *testing.T) {
	counter := &atomic.Int32{}
	maxConc := &atomic.Int32{}
	st := &slowTool{duration: 30 * time.Millisecond, counter: counter, maxConc: maxConc}

	registry := tools.NewRegistry()
	registry.Register(st)

	provider := llm.NewMockProvider(
		&llm.Response{
			Content: "Running tools",
			ToolCalls: []llm.ToolCall{
				{ID: "c1", Name: "slow_tool", Params: map[string]any{"id": "a"}},
				{ID: "c2", Name: "slow_tool", Params: map[string]any{"id": "b"}},
				{ID: "c3", Name: "slow_tool", Params: map[string]any{"id": "c"}},
			},
		},
		&llm.Response{Content: "Done."},
	)

	log := transcript.NewLog()
	start := time.Now()
	_, err := Run(context.Background(), provider, registry, log, Config{
		MaxTurns:      5,
		ParallelTools: false, // disabled
	}, "run them")
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Sequential should take >= 90ms (3 * 30ms).
	if elapsed < 80*time.Millisecond {
		t.Errorf("elapsed %v suggests parallel execution, expected sequential", elapsed)
	}

	// Max concurrency should be 1 for sequential.
	if maxConc.Load() != 1 {
		t.Errorf("max concurrency = %d, want 1", maxConc.Load())
	}
}

func TestParallel_MaxConcurrencyLimited(t *testing.T) {
	counter := &atomic.Int32{}
	maxConc := &atomic.Int32{}
	st := &slowTool{duration: 50 * time.Millisecond, counter: counter, maxConc: maxConc}

	registry := tools.NewRegistry()
	registry.Register(st)

	// 6 tool calls with max parallel = 2.
	calls := make([]llm.ToolCall, 6)
	for i := range calls {
		calls[i] = llm.ToolCall{ID: "c" + string(rune('0'+i)), Name: "slow_tool", Params: map[string]any{"id": "x"}}
	}

	provider := llm.NewMockProvider(
		&llm.Response{Content: "Go", ToolCalls: calls},
		&llm.Response{Content: "Done."},
	)

	log := transcript.NewLog()
	_, err := Run(context.Background(), provider, registry, log, Config{
		MaxTurns:         5,
		ParallelTools:    true,
		MaxParallelTools: 2,
	}, "run them")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if maxConc.Load() > 2 {
		t.Errorf("max concurrency = %d, want <= 2", maxConc.Load())
	}
}

func TestParallel_ContextCancellation(t *testing.T) {
	counter := &atomic.Int32{}
	maxConc := &atomic.Int32{}
	st := &slowTool{duration: 500 * time.Millisecond, counter: counter, maxConc: maxConc}

	registry := tools.NewRegistry()
	registry.Register(st)

	provider := llm.NewMockProvider(
		&llm.Response{
			Content: "Go",
			ToolCalls: []llm.ToolCall{
				{ID: "c1", Name: "slow_tool", Params: map[string]any{"id": "a"}},
				{ID: "c2", Name: "slow_tool", Params: map[string]any{"id": "b"}},
				{ID: "c3", Name: "slow_tool", Params: map[string]any{"id": "c"}},
			},
		},
		&llm.Response{Content: "Done."},
	)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	log := transcript.NewLog()
	result, err := Run(ctx, provider, registry, log, Config{
		MaxTurns:      5,
		ParallelTools: true,
	}, "run them")

	if err == nil {
		t.Fatal("expected context cancellation error")
	}
	if result.StopReason != "cancelled" {
		t.Errorf("stop_reason = %s, want cancelled", result.StopReason)
	}
}

func TestParallel_PanicRecovery(t *testing.T) {
	registry := tools.NewRegistry()
	registry.Register(&panicTool{})

	counter := &atomic.Int32{}
	maxConc := &atomic.Int32{}
	st := &slowTool{duration: 10 * time.Millisecond, counter: counter, maxConc: maxConc}
	registry.Register(st)

	provider := llm.NewMockProvider(
		&llm.Response{
			Content: "Go",
			ToolCalls: []llm.ToolCall{
				{ID: "c1", Name: "slow_tool", Params: map[string]any{"id": "safe"}},
				{ID: "c2", Name: "panic_tool", Params: map[string]any{"msg": "boom"}},
				{ID: "c3", Name: "slow_tool", Params: map[string]any{"id": "also_safe"}},
			},
		},
		&llm.Response{Content: "Handled."},
	)

	log := transcript.NewLog()
	result, err := Run(context.Background(), provider, registry, log, Config{
		MaxTurns:      5,
		ParallelTools: true,
	}, "run them")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}

	// Verify the panic was captured as an error result.
	msgs := provider.CallMessages(1)
	if msgs == nil {
		t.Fatal("expected second LLM call with tool results")
	}
	var panicResult *llm.ToolResult
	for _, m := range msgs {
		if m.Role == llm.RoleTool && m.ToolResult != nil && m.ToolResult.CallID == "c2" {
			panicResult = m.ToolResult
			break
		}
	}
	if panicResult == nil {
		t.Fatal("expected tool result for panicking tool")
	}
	if !panicResult.IsError {
		t.Error("expected panic result to be marked as error")
	}
	if panicResult.Content != "panic: boom" {
		t.Errorf("panic content = %q, want %q", panicResult.Content, "panic: boom")
	}
}
