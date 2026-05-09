package context

import (
	"strings"
	"testing"
	"time"

	"github.com/workspace/harness/llm"
)

func TestEstimateTokens_Empty(t *testing.T) {
	if got := EstimateTokens(""); got != 0 {
		t.Errorf("EstimateTokens(\"\") = %d, want 0", got)
	}
}

func TestEstimateTokens_Short(t *testing.T) {
	got := EstimateTokens("hi")
	if got < 1 {
		t.Errorf("EstimateTokens(\"hi\") = %d, want >= 1", got)
	}
}

func TestEstimateTokens_EnglishText(t *testing.T) {
	// "The quick brown fox jumps over the lazy dog" is ~10 tokens by most tokenizers.
	text := "The quick brown fox jumps over the lazy dog"
	got := EstimateTokens(text)
	// Should be within 20% of ~10.
	if got < 8 || got > 15 {
		t.Errorf("EstimateTokens(%q) = %d, want 8-15", text, got)
	}
}

func TestEstimateTokens_Code(t *testing.T) {
	code := `func main() {
	fmt.Println("Hello, World!")
}`
	got := EstimateTokens(code)
	// ~46 chars / 4 ≈ 12 tokens. Real tokenizers give ~15. Within 20% is fine.
	if got < 8 || got > 20 {
		t.Errorf("EstimateTokens(code) = %d, want 8-20", got)
	}
}

func TestEstimateTokens_Performance(t *testing.T) {
	// Must be < 1ms for a 10k character string.
	text := strings.Repeat("Hello world, this is a test. ", 400) // ~11200 chars
	start := time.Now()
	for i := 0; i < 1000; i++ {
		EstimateTokens(text)
	}
	elapsed := time.Since(start)
	perCall := elapsed / 1000
	if perCall > time.Millisecond {
		t.Errorf("EstimateTokens took %v per call on 10k+ chars, want < 1ms", perCall)
	}
}

func TestMessageTokens_ContentOnly(t *testing.T) {
	msg := llm.Message{Role: llm.RoleUser, Content: "Hello, how are you?"}
	got := MessageTokens(msg)
	// 4 (role overhead) + content tokens
	contentTokens := EstimateTokens("Hello, how are you?")
	expected := 4 + contentTokens
	if got != expected {
		t.Errorf("MessageTokens = %d, want %d", got, expected)
	}
}

func TestMessageTokens_WithToolCalls(t *testing.T) {
	msg := llm.Message{
		Role: llm.RoleAssistant,
		ToolCalls: []llm.ToolCall{{
			ID:     "call-1",
			Name:   "read_file",
			Params: map[string]any{"path": "test.txt"},
		}},
	}
	got := MessageTokens(msg)
	if got <= 4 {
		t.Errorf("MessageTokens with tool calls = %d, want > 4", got)
	}
}

func TestMessageTokens_WithToolResult(t *testing.T) {
	msg := llm.Message{
		Role: llm.RoleTool,
		ToolResult: &llm.ToolResult{
			CallID:  "call-1",
			Content: "file contents here",
		},
	}
	got := MessageTokens(msg)
	if got <= 4 {
		t.Errorf("MessageTokens with tool result = %d, want > 4", got)
	}
}

func TestConversationTokens(t *testing.T) {
	msgs := []llm.Message{
		{Role: llm.RoleSystem, Content: "You are helpful."},
		{Role: llm.RoleUser, Content: "Hello"},
		{Role: llm.RoleAssistant, Content: "Hi there!"},
	}
	got := ConversationTokens(msgs)
	// Should be sum of individual message tokens.
	expected := 0
	for _, m := range msgs {
		expected += MessageTokens(m)
	}
	if got != expected {
		t.Errorf("ConversationTokens = %d, want %d", got, expected)
	}
}

func TestConversationTokens_Empty(t *testing.T) {
	if got := ConversationTokens(nil); got != 0 {
		t.Errorf("ConversationTokens(nil) = %d, want 0", got)
	}
}

func TestContextLimitForModel_Known(t *testing.T) {
	got := ContextLimitForModel("gemma-4-27b", 30000)
	if got != 32768 {
		t.Errorf("ContextLimitForModel(gemma-4-27b) = %d, want 32768", got)
	}
}

func TestContextLimitForModel_Unknown(t *testing.T) {
	got := ContextLimitForModel("unknown-model", 30000)
	if got != 30000 {
		t.Errorf("ContextLimitForModel(unknown) = %d, want 30000", got)
	}
}
