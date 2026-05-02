package tools

import (
	"context"
	"testing"

	"github.com/workspace/harness/llm"
)

// echoTool is a simple tool for testing that returns its input.
type echoTool struct{}

func (e *echoTool) Name() string        { return "echo" }
func (e *echoTool) Description() string { return "Echoes input" }
func (e *echoTool) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"text": map[string]any{"type": "string"},
		},
	}
}
func (e *echoTool) Execute(_ context.Context, params map[string]any) (string, error) {
	text, _ := params["text"].(string)
	return "echo: " + text, nil
}

func TestRegistry_RegisterAndDispatch(t *testing.T) {
	reg := NewRegistry()
	err := reg.Register(&echoTool{})
	if err != nil {
		t.Fatalf("register failed: %v", err)
	}

	result := reg.Dispatch(context.Background(), llm.ToolCall{
		ID:     "call-1",
		Name:   "echo",
		Params: map[string]any{"text": "hello"},
	})

	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if result.Content != "echo: hello" {
		t.Errorf("got %q, want %q", result.Content, "echo: hello")
	}
	if result.CallID != "call-1" {
		t.Errorf("call_id = %q, want %q", result.CallID, "call-1")
	}
}

func TestRegistry_DuplicateRegistration(t *testing.T) {
	reg := NewRegistry()
	_ = reg.Register(&echoTool{})
	err := reg.Register(&echoTool{})
	if err == nil {
		t.Fatal("expected error on duplicate registration")
	}
}

func TestRegistry_UnknownTool(t *testing.T) {
	reg := NewRegistry()
	result := reg.Dispatch(context.Background(), llm.ToolCall{
		ID:   "call-1",
		Name: "nonexistent",
	})
	if !result.IsError {
		t.Fatal("expected error for unknown tool")
	}
}

func TestRegistry_Definitions(t *testing.T) {
	reg := NewRegistry()
	_ = reg.Register(&echoTool{})

	defs := reg.Definitions()
	if len(defs) != 1 {
		t.Fatalf("got %d definitions, want 1", len(defs))
	}
	if defs[0].Name != "echo" {
		t.Errorf("name = %q, want %q", defs[0].Name, "echo")
	}
}
