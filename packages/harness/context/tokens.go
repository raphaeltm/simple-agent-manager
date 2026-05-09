// Package context provides context window management for the agent harness.
package context

import (
	"encoding/json"

	"github.com/workspace/harness/llm"
)

// DefaultContextLimits maps model identifiers to their maximum context token counts.
var DefaultContextLimits = map[string]int{
	"gemma-4-27b":               32768,
	"@cf/google/gemma-4-27b-it": 32768,
	"gpt-4o-mini":               128000,
	"gpt-4o":                    128000,
	"gpt-4.1-nano":              1047576,
	"claude-sonnet-4-6":         200000,
}

// EstimateTokens provides a fast approximate token count for a string.
// Uses the ~4 characters per token heuristic which is reasonable for
// English text and code. No CGO required.
func EstimateTokens(text string) int {
	if len(text) == 0 {
		return 0
	}
	// ~4 characters per token, with a minimum of 1 token for non-empty strings.
	tokens := (len(text) + 3) / 4
	if tokens == 0 {
		tokens = 1
	}
	return tokens
}

// MessageTokens estimates the token count for a single message.
// Includes role overhead, content, and serialized tool calls/results.
func MessageTokens(msg llm.Message) int {
	// Role token overhead (~4 tokens for role + framing).
	tokens := 4

	tokens += EstimateTokens(msg.Content)

	for _, tc := range msg.ToolCalls {
		tokens += EstimateTokens(tc.Name)
		tokens += EstimateTokens(tc.ID)
		if tc.Params != nil {
			b, _ := json.Marshal(tc.Params)
			tokens += EstimateTokens(string(b))
		}
	}

	if msg.ToolResult != nil {
		tokens += EstimateTokens(msg.ToolResult.Content)
		tokens += EstimateTokens(msg.ToolResult.CallID)
	}

	return tokens
}

// ConversationTokens returns the total estimated token count across all messages.
func ConversationTokens(msgs []llm.Message) int {
	total := 0
	for _, msg := range msgs {
		total += MessageTokens(msg)
	}
	return total
}

// ContextLimitForModel returns the context limit for a model, falling back
// to defaultTokens if the model is not in the known limits map.
func ContextLimitForModel(model string, defaultTokens int) int {
	if limit, ok := DefaultContextLimits[model]; ok {
		return limit
	}
	return defaultTokens
}
