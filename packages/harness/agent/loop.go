// Package agent implements the core think-act-observe agent loop.
package agent

import (
	"context"
	"fmt"

	ctxmgr "github.com/workspace/harness/context"
	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/tools"
	"github.com/workspace/harness/transcript"
)

// Config configures the agent loop.
type Config struct {
	// SystemPrompt is prepended to every LLM call.
	SystemPrompt string
	// MaxTurns is the maximum number of think-act-observe cycles. 0 means 10.
	MaxTurns int
	// MaxContextTokens is the context window budget. 0 means 30000.
	MaxContextTokens int
	// CompactOptions controls compaction behavior. Zero value uses defaults.
	CompactOptions ctxmgr.CompactOptions
}

// Result is the outcome of an agent run.
type Result struct {
	// FinalMessage is the last assistant message content (non-tool-call).
	FinalMessage string
	// TurnsUsed is how many turns the agent took.
	TurnsUsed int
	// StopReason indicates why the agent stopped.
	StopReason string
}

// Run executes the agent loop: think -> act -> observe, repeating until
// the model stops calling tools or max turns is reached.
func Run(ctx context.Context, provider llm.Provider, registry *tools.Registry, log *transcript.Log, cfg Config, userPrompt string) (*Result, error) {
	maxTurns := cfg.MaxTurns
	if maxTurns <= 0 {
		maxTurns = 10
	}

	maxContextTokens := cfg.MaxContextTokens
	if maxContextTokens <= 0 {
		maxContextTokens = 30000
	}

	compactOpts := cfg.CompactOptions
	if compactOpts.Threshold <= 0 {
		compactOpts = ctxmgr.DefaultCompactOptions()
	}

	toolDefs := registry.Definitions()

	// Build initial conversation.
	messages := []llm.Message{}
	if cfg.SystemPrompt != "" {
		messages = append(messages, llm.Message{Role: llm.RoleSystem, Content: cfg.SystemPrompt})
	}
	messages = append(messages, llm.Message{Role: llm.RoleUser, Content: userPrompt})

	for turn := 1; turn <= maxTurns; turn++ {
		// Check cancellation.
		if err := ctx.Err(); err != nil {
			return &Result{TurnsUsed: turn - 1, StopReason: "cancelled"}, err
		}

		// Compact conversation if approaching context limit.
		if ctxmgr.NeedsCompaction(messages, maxContextTokens, compactOpts) {
			compacted, cr := ctxmgr.Compact(messages, maxContextTokens, compactOpts)
			if cr.Compacted {
				log.Append(transcript.EventInfo, turn, map[string]any{
					"event":            "compaction",
					"messages_removed": cr.MessagesRemoved,
					"tokens_before":    cr.TokensBefore,
					"tokens_after":     cr.TokensAfter,
				})
				messages = compacted
			}
		}

		// Think: send to LLM.
		log.Append(transcript.EventLLMRequest, turn, map[string]any{
			"message_count": len(messages),
			"tool_count":    len(toolDefs),
		})

		resp, err := provider.SendMessage(ctx, messages, toolDefs)
		if err != nil {
			log.Append(transcript.EventError, turn, map[string]any{"error": err.Error()})
			return &Result{TurnsUsed: turn, StopReason: "error"}, fmt.Errorf("turn %d: LLM error: %w", turn, err)
		}

		log.Append(transcript.EventLLMResponse, turn, map[string]any{
			"content":       resp.Content,
			"tool_call_count": len(resp.ToolCalls),
			"stop_reason":   resp.StopReason,
		})

		// If no tool calls, the model is done.
		if len(resp.ToolCalls) == 0 {
			return &Result{
				FinalMessage: resp.Content,
				TurnsUsed:    turn,
				StopReason:   "complete",
			}, nil
		}

		// Add assistant message with tool calls.
		messages = append(messages, llm.Message{
			Role:      llm.RoleAssistant,
			Content:   resp.Content,
			ToolCalls: resp.ToolCalls,
		})

		// Act + Observe: execute each tool call, checking cancellation between calls.
		for _, call := range resp.ToolCalls {
			if err := ctx.Err(); err != nil {
				return &Result{TurnsUsed: turn, StopReason: "cancelled"}, err
			}
			log.Append(transcript.EventToolCall, turn, map[string]any{
				"id":     call.ID,
				"name":   call.Name,
				"params": call.Params,
			})

			result := registry.Dispatch(ctx, call)

			log.Append(transcript.EventToolResult, turn, map[string]any{
				"call_id":  result.CallID,
				"is_error": result.IsError,
				"content":  truncate(result.Content, 500),
			})

			messages = append(messages, llm.Message{
				Role:       llm.RoleTool,
				ToolResult: &result,
			})
		}
	}

	return &Result{
		TurnsUsed:  maxTurns,
		StopReason: "max_turns",
	}, nil
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "...(truncated)"
}
