package context

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/workspace/harness/llm"
)

// errorProvider always returns an error from SendMessage.
type errorProvider struct{}

func (e *errorProvider) SendMessage(_ context.Context, _ []llm.Message, _ []llm.ToolDefinition) (*llm.Response, error) {
	return nil, fmt.Errorf("provider unavailable")
}

func TestLLMCompactor_CallsProviderWithSummarizationPrompt(t *testing.T) {
	mock := llm.NewMockProvider(&llm.Response{Content: "Here is the summary of the conversation."})
	compactor := NewLLMCompactor(mock)

	msgs := buildLongConversation(20, "system prompt")
	opts := DefaultCompactOptions()

	_, cr := compactor.Compact(context.Background(), msgs, 200, opts)

	if !cr.Compacted {
		t.Fatal("expected compaction to trigger")
	}
	if mock.CallCount() != 1 {
		t.Fatalf("expected 1 LLM call, got %d", mock.CallCount())
	}

	// Verify the summarization request includes the system prompt for summarization.
	callMsgs := mock.CallMessages(0)
	if len(callMsgs) < 2 {
		t.Fatal("expected at least 2 messages in summarization request")
	}
	if callMsgs[0].Role != llm.RoleSystem {
		t.Error("first message in summarization call should be system role")
	}
	if !strings.Contains(callMsgs[0].Content, "Summarize") {
		t.Error("summarization system prompt should contain 'Summarize'")
	}
}

func TestLLMCompactor_PreservesSystemPrompt(t *testing.T) {
	mock := llm.NewMockProvider(&llm.Response{Content: "Summary of work done."})
	compactor := NewLLMCompactor(mock)

	msgs := buildLongConversation(20, "important system prompt")
	opts := DefaultCompactOptions()

	result, cr := compactor.Compact(context.Background(), msgs, 200, opts)

	if !cr.Compacted {
		t.Fatal("expected compaction")
	}
	if result[0].Role != llm.RoleSystem {
		t.Error("first message should be system prompt")
	}
	if result[0].Content != "important system prompt" {
		t.Errorf("system prompt changed: %q", result[0].Content)
	}
}

func TestLLMCompactor_PreservesRecentMessages(t *testing.T) {
	mock := llm.NewMockProvider(&llm.Response{Content: "Summary."})
	compactor := NewLLMCompactor(mock)

	msgs := buildLongConversation(20, "sys")
	opts := CompactOptions{Threshold: 0.8, KeepRecent: 6}

	result, cr := compactor.Compact(context.Background(), msgs, 200, opts)

	if !cr.Compacted {
		t.Fatal("expected compaction")
	}

	// Last 6 messages should be preserved from original.
	recentResult := result[len(result)-6:]
	recentOriginal := msgs[len(msgs)-6:]
	for i := range recentResult {
		if recentResult[i].Content != recentOriginal[i].Content {
			t.Errorf("recent message %d changed: got %q, want %q",
				i, recentResult[i].Content, recentOriginal[i].Content)
		}
	}
}

func TestLLMCompactor_SummaryReplacesOlderMessages(t *testing.T) {
	mock := llm.NewMockProvider(&llm.Response{Content: "Condensed summary of prior work."})
	compactor := NewLLMCompactor(mock)

	msgs := buildLongConversation(20, "sys")
	opts := CompactOptions{Threshold: 0.8, KeepRecent: 6}

	result, cr := compactor.Compact(context.Background(), msgs, 200, opts)

	if !cr.Compacted {
		t.Fatal("expected compaction")
	}

	// Result should be: system + summary + 6 recent = 8 messages.
	expected := 1 + 1 + 6
	if len(result) != expected {
		t.Errorf("expected %d messages, got %d", expected, len(result))
	}

	// The summary message should contain the LLM's output.
	summaryMsg := result[1]
	if !strings.Contains(summaryMsg.Content, "Condensed summary of prior work.") {
		t.Errorf("summary message should contain LLM output, got: %q", summaryMsg.Content)
	}
}

func TestLLMCompactor_FallbackToExtractiveOnFailure(t *testing.T) {
	compactor := NewLLMCompactor(&errorProvider{})

	msgs := buildLongConversation(20, "system prompt")
	opts := DefaultCompactOptions()

	result, cr := compactor.Compact(context.Background(), msgs, 200, opts)

	if !cr.Compacted {
		t.Fatal("expected compaction via fallback")
	}

	// Should fall back to extractive: summary should contain the extractive marker.
	summaryMsg := result[1]
	if !strings.Contains(summaryMsg.Content, "Conversation compacted") {
		t.Error("fallback should use extractive compaction marker")
	}

	// Should NOT contain LLM summary marker.
	if strings.Contains(summaryMsg.Content, "LLM summary") {
		t.Error("fallback should not contain LLM summary marker")
	}
}

func TestLLMCompactor_UnderThreshold_NoOp(t *testing.T) {
	mock := llm.NewMockProvider(&llm.Response{Content: "should not be called"})
	compactor := NewLLMCompactor(mock)

	msgs := []llm.Message{
		{Role: llm.RoleSystem, Content: "sys"},
		{Role: llm.RoleUser, Content: "hi"},
	}
	opts := DefaultCompactOptions()

	result, cr := compactor.Compact(context.Background(), msgs, 100000, opts)

	if cr.Compacted {
		t.Error("should not compact when under threshold")
	}
	if len(result) != len(msgs) {
		t.Error("messages should be unchanged")
	}
	if mock.CallCount() != 0 {
		t.Error("LLM should not be called when under threshold")
	}
}
