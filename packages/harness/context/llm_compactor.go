package context

import (
	"context"
	"fmt"

	"github.com/workspace/harness/llm"
)

// LLMCompactor uses an LLM provider to generate a conversation summary,
// replacing older messages with a single condensed summary message.
type LLMCompactor struct {
	Provider llm.Provider
}

// NewLLMCompactor creates a compactor that delegates summarization to the given provider.
func NewLLMCompactor(provider llm.Provider) *LLMCompactor {
	return &LLMCompactor{Provider: provider}
}

// summarizationPrompt is sent to the LLM to produce a concise summary.
const summarizationPrompt = `Summarize the following conversation between a user and an AI coding assistant. Focus on:
- Key decisions made
- Files read, created, or modified
- Errors encountered and how they were resolved
- Current state of the task

Be concise. Output only the summary, no preamble.`

// Compact uses the LLM to summarize older messages, preserving the system prompt
// and the most recent messages. If the LLM call fails, it falls back to extractive compaction.
func (c *LLMCompactor) Compact(ctx context.Context, msgs []llm.Message, maxTokens int, opts CompactOptions) ([]llm.Message, CompactResult) {
	tokensBefore := ConversationTokens(msgs)

	threshold := opts.Threshold
	if threshold <= 0 || threshold > 1 {
		threshold = 0.8
	}
	keepRecent := opts.KeepRecent
	if keepRecent <= 0 {
		keepRecent = 6
	}

	// If under threshold, no-op.
	if tokensBefore <= int(float64(maxTokens)*threshold) {
		return msgs, CompactResult{TokensBefore: tokensBefore, TokensAfter: tokensBefore}
	}

	// Determine boundaries.
	startIdx := 0
	hasSystem := len(msgs) > 0 && msgs[0].Role == llm.RoleSystem
	if hasSystem {
		startIdx = 1
	}

	// Need at least one middle message to compact.
	middleEnd := len(msgs) - keepRecent
	if middleEnd <= startIdx {
		return msgs, CompactResult{TokensBefore: tokensBefore, TokensAfter: tokensBefore}
	}

	middleMessages := msgs[startIdx:middleEnd]

	// Ask the LLM to summarize the middle section.
	summary, err := c.summarize(ctx, middleMessages)
	if err != nil {
		// Fallback to extractive compaction on LLM failure.
		return Compact(msgs, maxTokens, opts)
	}

	summaryMsg := llm.Message{
		Role:    llm.RoleUser,
		Content: "[Conversation compacted via LLM summary]\n\n" + summary,
	}

	// Build compacted conversation: [system?] + [summary] + [recent tail]
	compacted := make([]llm.Message, 0, 2+keepRecent)
	if hasSystem {
		compacted = append(compacted, msgs[0])
	}
	compacted = append(compacted, summaryMsg)
	compacted = append(compacted, msgs[middleEnd:]...)

	tokensAfter := ConversationTokens(compacted)

	return compacted, CompactResult{
		Compacted:       true,
		MessagesRemoved: len(middleMessages),
		TokensBefore:    tokensBefore,
		TokensAfter:     tokensAfter,
	}
}

// summarize sends the middle messages to the LLM for summarization.
func (c *LLMCompactor) summarize(ctx context.Context, msgs []llm.Message) (string, error) {
	// Build a user message containing the conversation to summarize.
	var conversationText string
	for _, msg := range msgs {
		role := string(msg.Role)
		content := msg.Content
		if content == "" && len(msg.ToolCalls) > 0 {
			content = fmt.Sprintf("[called tools: %s]", toolNames(msg.ToolCalls))
		}
		if msg.ToolResult != nil {
			content = msg.ToolResult.Content
			if len(content) > 500 {
				content = content[:500] + "..."
			}
		}
		conversationText += fmt.Sprintf("%s: %s\n", role, content)
	}

	reqMessages := []llm.Message{
		{Role: llm.RoleSystem, Content: summarizationPrompt},
		{Role: llm.RoleUser, Content: conversationText},
	}

	resp, err := c.Provider.SendMessage(ctx, reqMessages, nil)
	if err != nil {
		return "", fmt.Errorf("llm summarization failed: %w", err)
	}

	if resp.Content == "" {
		return "", fmt.Errorf("llm returned empty summary")
	}

	return resp.Content, nil
}

// toolNames extracts tool names from a slice of tool calls.
func toolNames(calls []llm.ToolCall) string {
	names := ""
	for i, tc := range calls {
		if i > 0 {
			names += ", "
		}
		names += tc.Name
	}
	return names
}
