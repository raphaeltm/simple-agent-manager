package context

import (
	"fmt"
	"strings"

	"github.com/workspace/harness/llm"
)

// CompactOptions controls compaction behavior.
type CompactOptions struct {
	// Threshold is the fraction of MaxTokens at which compaction triggers (0.0-1.0).
	// Default: 0.8 (80%).
	Threshold float64
	// KeepRecent is the number of recent messages to always preserve.
	// Default: 6.
	KeepRecent int
}

// DefaultCompactOptions returns sensible defaults.
func DefaultCompactOptions() CompactOptions {
	return CompactOptions{
		Threshold:  0.8,
		KeepRecent: 6,
	}
}

// CompactResult describes what happened during compaction.
type CompactResult struct {
	// Compacted is true if messages were actually reduced.
	Compacted bool
	// MessagesRemoved is how many messages were replaced by the summary.
	MessagesRemoved int
	// TokensBefore is the estimated token count before compaction.
	TokensBefore int
	// TokensAfter is the estimated token count after compaction.
	TokensAfter int
}

// NeedsCompaction returns true if the conversation exceeds the token threshold.
func NeedsCompaction(msgs []llm.Message, maxTokens int, opts CompactOptions) bool {
	threshold := opts.Threshold
	if threshold <= 0 || threshold > 1 {
		threshold = 0.8
	}
	current := ConversationTokens(msgs)
	return current > int(float64(maxTokens)*threshold)
}

// Compact reduces the conversation to fit within maxTokens by summarizing
// the middle section while preserving the system prompt and recent messages.
//
// Strategy:
//  1. Always keep the system prompt (first message if role=system).
//  2. Always keep the last KeepRecent messages.
//  3. Replace the middle section with a single summary message.
//  4. The summary uses extractive summarization (no LLM call).
func Compact(msgs []llm.Message, maxTokens int, opts CompactOptions) ([]llm.Message, CompactResult) {
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

	// If there aren't enough messages to compact, return as-is.
	// We need at least: [system?] + [1 middle msg] + [keepRecent tail msgs]
	middleEnd := len(msgs) - keepRecent
	if middleEnd <= startIdx {
		return msgs, CompactResult{TokensBefore: tokensBefore, TokensAfter: tokensBefore}
	}

	middleMessages := msgs[startIdx:middleEnd]
	summary := extractSummary(middleMessages)

	summaryMsg := llm.Message{
		Role:    llm.RoleUser,
		Content: summary,
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

// extractSummary creates a concise extractive summary from middle messages.
// It preserves: key decisions, files modified, errors encountered.
func extractSummary(msgs []llm.Message) string {
	var (
		decisions  []string
		files      []string
		errors     []string
		toolNames  []string
		filesSeen  = map[string]bool{}
		toolsSeen  = map[string]bool{}
	)

	for _, msg := range msgs {
		// Extract tool call info.
		for _, tc := range msg.ToolCalls {
			if !toolsSeen[tc.Name] {
				toolsSeen[tc.Name] = true
				toolNames = append(toolNames, tc.Name)
			}
			// Extract file paths from common tool params.
			if path, ok := tc.Params["path"].(string); ok && !filesSeen[path] {
				filesSeen[path] = true
				files = append(files, path)
			}
			if path, ok := tc.Params["file_path"].(string); ok && !filesSeen[path] {
				filesSeen[path] = true
				files = append(files, path)
			}
		}

		// Extract errors from tool results.
		if msg.ToolResult != nil && msg.ToolResult.IsError {
			errSnippet := msg.ToolResult.Content
			if len(errSnippet) > 200 {
				errSnippet = errSnippet[:200]
			}
			errors = append(errors, errSnippet)
		}

		// Extract short assistant decisions (non-tool-call assistant messages).
		if msg.Role == llm.RoleAssistant && len(msg.ToolCalls) == 0 && msg.Content != "" {
			snippet := msg.Content
			if len(snippet) > 150 {
				snippet = snippet[:150]
			}
			decisions = append(decisions, snippet)
		}
	}

	var parts []string
	parts = append(parts, "[Conversation compacted — earlier messages summarized]")

	if len(toolNames) > 0 {
		parts = append(parts, fmt.Sprintf("Tools used: %s", strings.Join(toolNames, ", ")))
	}
	if len(files) > 0 {
		parts = append(parts, fmt.Sprintf("Files touched: %s", strings.Join(files, ", ")))
	}
	if len(errors) > 0 {
		parts = append(parts, fmt.Sprintf("Errors encountered: %s", strings.Join(errors, "; ")))
	}
	if len(decisions) > 0 {
		// Keep at most 3 decision snippets.
		if len(decisions) > 3 {
			decisions = decisions[:3]
		}
		parts = append(parts, fmt.Sprintf("Key decisions: %s", strings.Join(decisions, " | ")))
	}

	return strings.Join(parts, "\n")
}
