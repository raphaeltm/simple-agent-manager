package context

import (
	"strings"
	"testing"

	"github.com/workspace/harness/llm"
)

func TestCompact_UnderThreshold_NoOp(t *testing.T) {
	msgs := []llm.Message{
		{Role: llm.RoleSystem, Content: "system"},
		{Role: llm.RoleUser, Content: "hello"},
	}
	opts := DefaultCompactOptions()
	result, cr := Compact(msgs, 100000, opts)

	if cr.Compacted {
		t.Error("expected no compaction when under threshold")
	}
	if len(result) != len(msgs) {
		t.Errorf("message count changed: got %d, want %d", len(result), len(msgs))
	}
}

func TestCompact_PreservesSystemPrompt(t *testing.T) {
	msgs := buildLongConversation(20, "system prompt here")
	opts := DefaultCompactOptions()
	// Set max tokens low enough to trigger compaction.
	result, cr := Compact(msgs, 200, opts)

	if !cr.Compacted {
		t.Fatal("expected compaction to trigger")
	}
	if result[0].Role != llm.RoleSystem {
		t.Error("first message should be system prompt")
	}
	if result[0].Content != "system prompt here" {
		t.Errorf("system prompt content changed: %q", result[0].Content)
	}
}

func TestCompact_PreservesRecentMessages(t *testing.T) {
	msgs := buildLongConversation(20, "system")
	opts := CompactOptions{Threshold: 0.8, KeepRecent: 6}
	result, cr := Compact(msgs, 200, opts)

	if !cr.Compacted {
		t.Fatal("expected compaction to trigger")
	}

	// Last 6 messages of result should match last 6 of original.
	recentResult := result[len(result)-6:]
	recentOriginal := msgs[len(msgs)-6:]
	for i := range recentResult {
		if recentResult[i].Content != recentOriginal[i].Content {
			t.Errorf("recent message %d changed: got %q, want %q",
				i, recentResult[i].Content, recentOriginal[i].Content)
		}
	}
}

func TestCompact_ReducesTokenCount(t *testing.T) {
	msgs := buildLongConversation(30, "system prompt")
	opts := DefaultCompactOptions()
	_, cr := Compact(msgs, 200, opts)

	if !cr.Compacted {
		t.Fatal("expected compaction")
	}
	if cr.TokensAfter >= cr.TokensBefore {
		t.Errorf("tokens not reduced: before=%d, after=%d", cr.TokensBefore, cr.TokensAfter)
	}
}

func TestCompact_SummaryContainsToolInfo(t *testing.T) {
	msgs := []llm.Message{
		{Role: llm.RoleSystem, Content: "system"},
		{Role: llm.RoleUser, Content: "read the file"},
		{Role: llm.RoleAssistant, Content: "reading", ToolCalls: []llm.ToolCall{
			{ID: "c1", Name: "read_file", Params: map[string]any{"path": "main.go"}},
		}},
		{Role: llm.RoleTool, ToolResult: &llm.ToolResult{CallID: "c1", Content: strings.Repeat("x", 500)}},
		{Role: llm.RoleAssistant, Content: "edit it", ToolCalls: []llm.ToolCall{
			{ID: "c2", Name: "edit_file", Params: map[string]any{"path": "main.go"}},
		}},
		{Role: llm.RoleTool, ToolResult: &llm.ToolResult{CallID: "c2", Content: "ok"}},
		// Recent tail (6 messages)
		{Role: llm.RoleUser, Content: "now check"},
		{Role: llm.RoleAssistant, Content: "checking"},
		{Role: llm.RoleUser, Content: "anything else?"},
		{Role: llm.RoleAssistant, Content: "no"},
		{Role: llm.RoleUser, Content: "great"},
		{Role: llm.RoleAssistant, Content: "done"},
	}

	opts := DefaultCompactOptions()
	result, cr := Compact(msgs, 100, opts)

	if !cr.Compacted {
		t.Fatal("expected compaction")
	}

	// The summary message (second message after system) should mention tools and files.
	summaryIdx := 1
	summary := result[summaryIdx].Content
	if !strings.Contains(summary, "read_file") {
		t.Error("summary should mention read_file tool")
	}
	if !strings.Contains(summary, "main.go") {
		t.Error("summary should mention main.go file")
	}
}

func TestCompact_SummaryContainsErrors(t *testing.T) {
	msgs := []llm.Message{
		{Role: llm.RoleSystem, Content: "system"},
		{Role: llm.RoleUser, Content: "do something"},
		{Role: llm.RoleAssistant, ToolCalls: []llm.ToolCall{
			{ID: "c1", Name: "bash", Params: map[string]any{"command": "fail"}},
		}},
		{Role: llm.RoleTool, ToolResult: &llm.ToolResult{CallID: "c1", Content: "command not found", IsError: true}},
		// Recent tail
		{Role: llm.RoleUser, Content: "a"},
		{Role: llm.RoleAssistant, Content: "b"},
		{Role: llm.RoleUser, Content: "c"},
		{Role: llm.RoleAssistant, Content: "d"},
		{Role: llm.RoleUser, Content: "e"},
		{Role: llm.RoleAssistant, Content: "f"},
	}

	opts := DefaultCompactOptions()
	result, cr := Compact(msgs, 50, opts)

	if !cr.Compacted {
		t.Fatal("expected compaction")
	}

	summary := result[1].Content
	if !strings.Contains(summary, "command not found") {
		t.Error("summary should mention the error")
	}
}

func TestCompact_TooFewMessages_NoOp(t *testing.T) {
	// Only system + 3 messages (fewer than keepRecent=6), should not compact.
	msgs := []llm.Message{
		{Role: llm.RoleSystem, Content: "sys"},
		{Role: llm.RoleUser, Content: "a"},
		{Role: llm.RoleAssistant, Content: "b"},
	}
	opts := DefaultCompactOptions()
	result, cr := Compact(msgs, 10, opts) // very low max tokens

	if cr.Compacted {
		t.Error("should not compact when fewer messages than keepRecent + system")
	}
	if len(result) != len(msgs) {
		t.Errorf("message count changed: got %d, want %d", len(result), len(msgs))
	}
}

func TestCompact_NoSystemPrompt(t *testing.T) {
	// Conversation without a system message.
	msgs := make([]llm.Message, 20)
	for i := range msgs {
		if i%2 == 0 {
			msgs[i] = llm.Message{Role: llm.RoleUser, Content: strings.Repeat("word ", 50)}
		} else {
			msgs[i] = llm.Message{Role: llm.RoleAssistant, Content: strings.Repeat("reply ", 50)}
		}
	}

	opts := DefaultCompactOptions()
	result, cr := Compact(msgs, 200, opts)

	if !cr.Compacted {
		t.Fatal("expected compaction")
	}
	// First message should be the summary (no system prompt to keep).
	if !strings.Contains(result[0].Content, "compacted") {
		t.Error("first message should be the summary when no system prompt")
	}
}

func TestNeedsCompaction(t *testing.T) {
	msgs := []llm.Message{
		{Role: llm.RoleUser, Content: strings.Repeat("a", 1000)},
	}
	opts := DefaultCompactOptions()

	// Under threshold.
	if NeedsCompaction(msgs, 100000, opts) {
		t.Error("should not need compaction with high limit")
	}

	// Over threshold.
	if !NeedsCompaction(msgs, 100, opts) {
		t.Error("should need compaction with low limit")
	}
}

// buildLongConversation creates a conversation with the given number of
// user/assistant pairs plus a system prompt.
func buildLongConversation(pairs int, systemContent string) []llm.Message {
	msgs := []llm.Message{{Role: llm.RoleSystem, Content: systemContent}}
	for i := 0; i < pairs; i++ {
		msgs = append(msgs,
			llm.Message{Role: llm.RoleUser, Content: strings.Repeat("question ", 30)},
			llm.Message{Role: llm.RoleAssistant, Content: strings.Repeat("answer ", 30)},
		)
	}
	return msgs
}
