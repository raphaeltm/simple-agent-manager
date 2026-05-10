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

// EventHandler receives streaming events from the agent loop.
// Implementations can display tokens in real-time, show progress, etc.
// If nil, the agent loop operates in batch mode (no streaming display).
type EventHandler interface {
	// OnToken is called for each content token as it streams from the LLM.
	OnToken(token string)
	// OnToolStart is called when a tool begins execution.
	OnToolStart(name string, params map[string]any)
	// OnToolEnd is called when a tool finishes execution.
	OnToolEnd(name string, result string, isError bool)
	// OnTurnStart is called at the beginning of each agent turn.
	OnTurnStart(turn, maxTurns int)
	// OnTurnEnd is called at the end of each agent turn.
	OnTurnEnd(turn int, toolCallCount int)
}

// CompactionStrategy selects the compaction algorithm.
type CompactionStrategy string

const (
	// CompactionExtractive uses heuristic extractive summarization (no LLM call).
	CompactionExtractive CompactionStrategy = "extractive"
	// CompactionLLM uses an LLM to produce a richer summary of older messages.
	CompactionLLM CompactionStrategy = "llm"
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
	// CompactionStrategy selects extractive (default) or llm-powered compaction.
	CompactionStrategy CompactionStrategy
	// WorkerModel is the model ID for subtask child sessions.
	// If empty, the orchestrator's model is used for workers too.
	WorkerModel string
	// WorkDir is the working directory for tools (needed for spawning child sessions).
	WorkDir string
	// ProviderConfig holds connection details for spawning child sessions.
	ProviderConfig *ProviderConfig
	// Handler receives streaming events. If nil, batch mode is used.
	Handler EventHandler
	// Stream enables streaming when the provider supports it. Default: false.
	Stream bool
}

// ProviderConfig stores provider connection details for child session spawning.
type ProviderConfig struct {
	Name       string // "openai" or "mock"
	APIURL     string
	APIKey     string
	AuthHeader string
	Model      string // orchestrator model
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

	// Check if the provider supports streaming.
	streamProvider, canStream := provider.(llm.StreamProvider)
	useStreaming := cfg.Stream && canStream

	for turn := 1; turn <= maxTurns; turn++ {
		// Check cancellation.
		if err := ctx.Err(); err != nil {
			return &Result{TurnsUsed: turn - 1, StopReason: "cancelled"}, err
		}

		if cfg.Handler != nil {
			cfg.Handler.OnTurnStart(turn, maxTurns)
		}

		// Compact conversation if approaching context limit.
		if ctxmgr.NeedsCompaction(messages, maxContextTokens, compactOpts) {
			var compacted []llm.Message
			var cr ctxmgr.CompactResult

			if cfg.CompactionStrategy == CompactionLLM {
				llmCompactor := ctxmgr.NewLLMCompactor(provider)
				compacted, cr = llmCompactor.Compact(ctx, messages, maxContextTokens, compactOpts)
			} else {
				compacted, cr = ctxmgr.Compact(messages, maxContextTokens, compactOpts)
			}

			if cr.Compacted {
				log.Append(transcript.EventInfo, turn, map[string]any{
					"event":            "compaction",
					"strategy":         string(cfg.CompactionStrategy),
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

		var (
			resp *llm.Response
			err  error
		)
		if useStreaming {
			resp, err = sendStreaming(ctx, streamProvider, messages, toolDefs, cfg.Handler)
		} else {
			resp, err = provider.SendMessage(ctx, messages, toolDefs)
		}
		if err != nil {
			log.Append(transcript.EventError, turn, map[string]any{"error": err.Error()})
			return &Result{TurnsUsed: turn, StopReason: "error"}, fmt.Errorf("turn %d: LLM error: %w", turn, err)
		}

		logData := map[string]any{
			"content":         resp.Content,
			"tool_call_count": len(resp.ToolCalls),
			"stop_reason":     resp.StopReason,
		}
		if resp.Usage != nil {
			logData["usage"] = resp.Usage
		}
		log.Append(transcript.EventLLMResponse, turn, logData)

		// If no tool calls, the model is done.
		if len(resp.ToolCalls) == 0 {
			if cfg.Handler != nil {
				cfg.Handler.OnTurnEnd(turn, 0)
			}
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

			if cfg.Handler != nil {
				cfg.Handler.OnToolStart(call.Name, call.Params)
			}

			result := registry.Dispatch(ctx, call)

			log.Append(transcript.EventToolResult, turn, map[string]any{
				"call_id":  result.CallID,
				"is_error": result.IsError,
				"content":  truncate(result.Content, 500),
			})

			if cfg.Handler != nil {
				cfg.Handler.OnToolEnd(call.Name, truncate(result.Content, 200), result.IsError)
			}

			messages = append(messages, llm.Message{
				Role:       llm.RoleTool,
				ToolResult: &result,
			})
		}

		if cfg.Handler != nil {
			cfg.Handler.OnTurnEnd(turn, len(resp.ToolCalls))
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

// sendStreaming calls a StreamProvider, forwards token events to the handler,
// and assembles the result into a complete Response.
func sendStreaming(ctx context.Context, sp llm.StreamProvider, messages []llm.Message, tools []llm.ToolDefinition, handler EventHandler) (*llm.Response, error) {
	events, err := sp.SendMessageStream(ctx, messages, tools)
	if err != nil {
		return nil, err
	}

	// If we have a handler, forward token events before collecting.
	if handler != nil {
		forwarded := make(chan llm.StreamEvent, 16)
		go func() {
			defer close(forwarded)
			for ev := range events {
				if ev.Type == llm.EventContentDelta {
					handler.OnToken(ev.Delta)
				}
				forwarded <- ev
			}
		}()
		return llm.CollectStream(forwarded)
	}

	return llm.CollectStream(events)
}
