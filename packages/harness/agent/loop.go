// Package agent implements the core think-act-observe agent loop.
package agent

import (
	"context"
	"fmt"
	"log"
	"sync"

	ctxmgr "github.com/workspace/harness/context"
	"github.com/workspace/harness/features"
	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/session"
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
	// The id parameter is the LLM-assigned tool call ID for correlating start/end events.
	OnToolStart(id string, name string, params map[string]any)
	// OnToolEnd is called when a tool finishes execution.
	// The id parameter matches the one from the corresponding OnToolStart call.
	OnToolEnd(id string, name string, result string, isError bool)
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
	// PermissionMode controls tool execution gating. Default: allow-all.
	PermissionMode tools.PermissionMode
	// PermissionChecker is called when a tool requires permission approval.
	// If nil and mode requires checks, tools are denied by default.
	PermissionChecker tools.PermissionChecker
	// ParallelTools enables parallel execution of multiple tool calls. Default: false.
	ParallelTools bool
	// MaxParallelTools is the maximum number of concurrent tool executions. Default: 5.
	MaxParallelTools int
	// SessionStore enables SQLite session persistence when set. Nil means no persistence.
	SessionStore *session.Store
	// SessionID is the session to persist messages to. Required if SessionStore is set.
	SessionID string
	// FeatureList enables opt-in harness-owned feature tracking and termination gating.
	FeatureList *features.List
	// MaxFeatureNudges is the number of no-tool early stops the gate converts
	// into continuation messages before terminating incomplete. The zero-value
	// default is 2 unless FeatureMaxNudgesSet is true.
	MaxFeatureNudges int
	// FeatureMaxNudgesSet allows callers such as the CLI to intentionally set
	// MaxFeatureNudges to 0 instead of receiving the default.
	FeatureMaxNudgesSet bool
	// InitialMessages, if non-empty, seeds the conversation instead of building
	// a fresh system+user pair. The new userPrompt is appended as a user message.
	// This allows callers (e.g. ACP handler) to carry conversation history
	// across multiple Run() invocations without a SessionStore.
	InitialMessages []llm.Message
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
	// TerminalStatus is the harness terminal status: complete or incomplete.
	TerminalStatus string
	// UnfinishedFeatures lists features that prevented successful completion.
	UnfinishedFeatures []features.Feature
	// Messages is the full conversation history at the end of the run.
	// Callers can feed this back via Config.InitialMessages to continue
	// the conversation in a subsequent Run() call.
	Messages []llm.Message
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

	featureList := loadFeatureList(cfg)
	featureMode := featureList != nil
	maxFeatureNudges := resolveMaxFeatureNudges(cfg)
	if featureMode {
		persistFeatures(cfg, featureList)
		if err := registerFeatureTools(registry, featureList, func() { persistFeatures(cfg, featureList) }); err != nil {
			return nil, err
		}
	}

	toolDefs := registry.Definitions()

	// Build initial conversation: in-memory history > session store > fresh start.
	var messages []llm.Message
	startTurn := 1

	if len(cfg.InitialMessages) > 0 {
		// Continue from in-memory history provided by the caller (e.g. ACP handler).
		messages = make([]llm.Message, len(cfg.InitialMessages))
		copy(messages, cfg.InitialMessages)
		if userPrompt != "" {
			messages = append(messages, llm.Message{Role: llm.RoleUser, Content: userPrompt})
		}
	} else if cfg.SessionStore != nil && cfg.SessionID != "" {
		if loaded, err := cfg.SessionStore.LoadMessages(cfg.SessionID); err == nil && len(loaded) > 0 {
			messages = loaded

			// Offset turn counter based on previous session state.
			if sess, err := cfg.SessionStore.LoadSession(cfg.SessionID); err == nil {
				startTurn = sess.TotalTurns + 1
			}

			// If a new user prompt is provided during resume, append it.
			if userPrompt != "" {
				newMsg := llm.Message{Role: llm.RoleUser, Content: userPrompt}
				messages = append(messages, newMsg)
				persistMessages(cfg, startTurn-1, []llm.Message{newMsg})
			}
		}
	}

	if len(messages) == 0 {
		if cfg.SystemPrompt != "" {
			messages = append(messages, llm.Message{Role: llm.RoleSystem, Content: cfg.SystemPrompt})
		}
		messages = append(messages, llm.Message{Role: llm.RoleUser, Content: userPrompt})
		if featureMode {
			featureMsg := llm.Message{Role: llm.RoleUser, Content: initialFeatureMessage(featureList.Snapshot(), maxFeatureNudges)}
			messages = append(messages, featureMsg)
		}

		// Persist the initial messages.
		persistMessages(cfg, 0, messages)
	}

	// Check if the provider supports streaming.
	streamProvider, canStream := provider.(llm.StreamProvider)
	useStreaming := cfg.Stream && canStream

	endTurn := startTurn + maxTurns
	for turn := startTurn; turn < endTurn; turn++ {
		// Check cancellation.
		if err := ctx.Err(); err != nil {
			return &Result{TurnsUsed: turn - startTurn, StopReason: "cancelled", Messages: messages}, err
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
			return &Result{TurnsUsed: turn - startTurn + 1, StopReason: "error", Messages: messages}, fmt.Errorf("turn %d: LLM error: %w", turn, err)
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
			if featureMode && !featureList.AllDone() {
				unfinished := featureList.Unfinished()
				if maxFeatureNudges > 0 {
					maxFeatureNudges--
					assistantMsg := llm.Message{Role: llm.RoleAssistant, Content: resp.Content}
					nudgeMsg := llm.Message{Role: llm.RoleUser, Content: features.NudgeMessage(unfinished, maxFeatureNudges)}
					messages = append(messages, assistantMsg, nudgeMsg)
					persistMessages(cfg, turn, []llm.Message{assistantMsg, nudgeMsg})
					log.Append(transcript.EventInfo, turn, map[string]any{
						"event":             "termination_gate_nudge",
						"remaining_nudges":  maxFeatureNudges,
						"unfinished_count":  len(unfinished),
						"unfinished_detail": features.Summary(unfinished),
					})
					if cfg.Handler != nil {
						cfg.Handler.OnTurnEnd(turn, 0)
					}
					continue
				}

				finalMessage := features.IncompleteMessage("model stopped calling tools before all features were done", unfinished)
				finalMsg := llm.Message{Role: llm.RoleAssistant, Content: finalMessage}
				messages = append(messages, finalMsg)
				persistMessages(cfg, turn, []llm.Message{finalMsg})
				persistStatus(cfg, "incomplete")
				logTerminalStatus(log, turn, "incomplete", unfinished, finalMessage)
				if cfg.Handler != nil {
					cfg.Handler.OnTurnEnd(turn, 0)
				}
				return &Result{
					FinalMessage:       finalMessage,
					TurnsUsed:          turn - startTurn + 1,
					StopReason:         "incomplete",
					TerminalStatus:     "incomplete",
					UnfinishedFeatures: unfinished,
					Messages:           messages,
				}, nil
			}

			// Persist the final assistant message.
			persistMessages(cfg, turn, []llm.Message{
				{Role: llm.RoleAssistant, Content: resp.Content},
			})
			persistStatus(cfg, "completed")
			if featureMode {
				logTerminalStatus(log, turn, "complete", nil, resp.Content)
			}

			// Add the final assistant message to history before returning.
			messages = append(messages, llm.Message{Role: llm.RoleAssistant, Content: resp.Content})

			if cfg.Handler != nil {
				cfg.Handler.OnTurnEnd(turn, 0)
			}
			return &Result{
				FinalMessage:   resp.Content,
				TurnsUsed:      turn - startTurn + 1,
				StopReason:     "complete",
				TerminalStatus: "complete",
				Messages:       messages,
			}, nil
		}

		// Add assistant message with tool calls.
		messages = append(messages, llm.Message{
			Role:      llm.RoleAssistant,
			Content:   resp.Content,
			ToolCalls: resp.ToolCalls,
		})

		// Act + Observe: execute tool calls (parallel or sequential).
		var toolResults []llm.ToolResult
		if cfg.ParallelTools && len(resp.ToolCalls) > 1 {
			toolResults = executeToolsParallel(ctx, registry, resp.ToolCalls, log, cfg, turn)
		} else {
			toolResults = executeToolsSequential(ctx, registry, resp.ToolCalls, log, cfg, turn)
		}

		// Check if context was cancelled during tool execution.
		if err := ctx.Err(); err != nil {
			return &Result{TurnsUsed: turn - startTurn + 1, StopReason: "cancelled", Messages: messages}, err
		}

		var turnMessages []llm.Message
		turnMessages = append(turnMessages, llm.Message{
			Role:      llm.RoleAssistant,
			Content:   resp.Content,
			ToolCalls: resp.ToolCalls,
		})
		for i := range toolResults {
			toolMsg := llm.Message{
				Role:       llm.RoleTool,
				ToolResult: &toolResults[i],
			}
			messages = append(messages, toolMsg)
			turnMessages = append(turnMessages, toolMsg)
		}

		// Persist this turn's messages (assistant + tool results).
		persistMessages(cfg, turn, turnMessages)

		if cfg.Handler != nil {
			cfg.Handler.OnTurnEnd(turn, len(resp.ToolCalls))
		}
	}

	if featureMode {
		unfinished := featureList.Unfinished()
		finalMessage := features.IncompleteMessage("max turns exhausted", unfinished)
		finalMsg := llm.Message{Role: llm.RoleAssistant, Content: finalMessage}
		messages = append(messages, finalMsg)
		persistMessages(cfg, endTurn-1, []llm.Message{finalMsg})
		persistStatus(cfg, "incomplete")
		logTerminalStatus(log, endTurn-1, "incomplete", unfinished, finalMessage)
		return &Result{
			FinalMessage:       finalMessage,
			TurnsUsed:          maxTurns,
			StopReason:         "incomplete",
			TerminalStatus:     "incomplete",
			UnfinishedFeatures: unfinished,
			Messages:           messages,
		}, nil
	}

	return &Result{
		TurnsUsed:      maxTurns,
		StopReason:     "max_turns",
		TerminalStatus: "incomplete",
		Messages:       messages,
	}, nil
}

// executeToolsSequential runs tool calls one at a time, checking context between each.
func executeToolsSequential(ctx context.Context, registry *tools.Registry, calls []llm.ToolCall, log *transcript.Log, cfg Config, turn int) []llm.ToolResult {
	results := make([]llm.ToolResult, 0, len(calls))
	for _, call := range calls {
		if err := ctx.Err(); err != nil {
			break
		}
		log.Append(transcript.EventToolCall, turn, map[string]any{
			"id":     call.ID,
			"name":   call.Name,
			"params": call.Params,
		})
		if cfg.Handler != nil {
			cfg.Handler.OnToolStart(call.ID, call.Name, call.Params)
		}

		// Permission check before execution.
		var result llm.ToolResult
		if denied, denyResult := checkToolPermission(registry, call, cfg); denied {
			result = denyResult
		} else {
			result = registry.Dispatch(ctx, call)
		}

		log.Append(transcript.EventToolResult, turn, map[string]any{
			"call_id":  result.CallID,
			"is_error": result.IsError,
			"content":  truncate(result.Content, 500),
		})
		if cfg.Handler != nil {
			cfg.Handler.OnToolEnd(call.ID, call.Name, truncate(result.Content, 200), result.IsError)
		}
		results = append(results, result)
	}
	return results
}

// executeToolsParallel runs tool calls concurrently with semaphore-based limiting.
func executeToolsParallel(ctx context.Context, registry *tools.Registry, calls []llm.ToolCall, log *transcript.Log, cfg Config, turn int) []llm.ToolResult {
	maxPar := cfg.MaxParallelTools
	if maxPar <= 0 {
		maxPar = 5
	}

	results := make([]llm.ToolResult, len(calls))
	sem := make(chan struct{}, maxPar)
	var wg sync.WaitGroup

	for i, call := range calls {
		if err := ctx.Err(); err != nil {
			break
		}

		log.Append(transcript.EventToolCall, turn, map[string]any{
			"id":     call.ID,
			"name":   call.Name,
			"params": call.Params,
		})
		if cfg.Handler != nil {
			cfg.Handler.OnToolStart(call.ID, call.Name, call.Params)
		}

		wg.Add(1)
		go func(idx int, tc llm.ToolCall) {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					results[idx] = llm.ToolResult{
						CallID:  tc.ID,
						Content: fmt.Sprintf("panic: %v", r),
						IsError: true,
					}
				}
			}()

			sem <- struct{}{}
			defer func() { <-sem }()

			if ctx.Err() != nil {
				results[idx] = llm.ToolResult{
					CallID:  tc.ID,
					Content: "context cancelled",
					IsError: true,
				}
				return
			}

			// Permission check before execution.
			if denied, denyResult := checkToolPermission(registry, tc, cfg); denied {
				results[idx] = denyResult
			} else {
				results[idx] = registry.Dispatch(ctx, tc)
			}
		}(i, call)
	}

	wg.Wait()

	// Fire OnToolEnd events in original order after all complete.
	for i, result := range results {
		log.Append(transcript.EventToolResult, turn, map[string]any{
			"call_id":  result.CallID,
			"is_error": result.IsError,
			"content":  truncate(result.Content, 500),
		})
		if cfg.Handler != nil {
			cfg.Handler.OnToolEnd(calls[i].ID, calls[i].Name, truncate(result.Content, 200), result.IsError)
		}
	}

	return results
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "...(truncated)"
}

// checkToolPermission evaluates whether a tool call is allowed under the current
// permission mode. Returns (true, result) if denied, (false, zero) if allowed.
func checkToolPermission(registry *tools.Registry, call llm.ToolCall, cfg Config) (bool, llm.ToolResult) {
	mode := cfg.PermissionMode
	if mode == "" || mode == tools.PermissionAllowAll {
		return false, llm.ToolResult{}
	}

	// Resolve danger level for this tool.
	level := tools.Dangerous // default for unknown tools
	if tool := registry.Get(call.Name); tool != nil {
		level = tools.GetDangerLevel(tool)
	}

	if !tools.NeedsPermission(mode, level) {
		return false, llm.ToolResult{}
	}

	// Permission check required — call the checker.
	checker := cfg.PermissionChecker
	if checker == nil {
		// No checker configured but mode requires one: deny.
		return true, llm.ToolResult{
			CallID:  call.ID,
			Content: fmt.Sprintf("error: tool %q (danger level: %s) requires permission but no checker is configured", call.Name, level),
			IsError: true,
		}
	}

	allowed, err := checker.CheckPermission(call.Name, call.Params, level)
	if err != nil {
		return true, llm.ToolResult{
			CallID:  call.ID,
			Content: fmt.Sprintf("error: permission check failed for tool %q: %v", call.Name, err),
			IsError: true,
		}
	}
	if !allowed {
		return true, llm.ToolResult{
			CallID:  call.ID,
			Content: fmt.Sprintf("error: permission denied for tool %q (danger level: %s)", call.Name, level),
			IsError: true,
		}
	}

	return false, llm.ToolResult{}
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

// persistMessages writes messages to the session store if configured.
// Errors are logged but never propagated — persistence is non-blocking.
func persistMessages(cfg Config, turn int, msgs []llm.Message) {
	if cfg.SessionStore == nil || cfg.SessionID == "" {
		return
	}
	if err := cfg.SessionStore.AppendMessages(cfg.SessionID, turn, msgs); err != nil {
		log.Printf("session persistence warning: %v", err)
	}
}

// persistStatus updates the session status if a store is configured.
func persistStatus(cfg Config, status string) {
	if cfg.SessionStore == nil || cfg.SessionID == "" {
		return
	}
	if err := cfg.SessionStore.UpdateStatus(cfg.SessionID, status); err != nil {
		log.Printf("session persistence warning: %v", err)
	}
}

func loadFeatureList(cfg Config) *features.List {
	if cfg.SessionStore != nil && cfg.SessionID != "" {
		if loaded, err := cfg.SessionStore.LoadFeatures(cfg.SessionID); err == nil && loaded != nil {
			return loaded
		} else if err != nil {
			log.Printf("session feature persistence warning: %v", err)
		}
	}
	return cfg.FeatureList
}

func persistFeatures(cfg Config, list *features.List) {
	if cfg.SessionStore == nil || cfg.SessionID == "" || list == nil {
		return
	}
	if err := cfg.SessionStore.SaveFeatures(cfg.SessionID, list); err != nil {
		log.Printf("session feature persistence warning: %v", err)
	}
}

func resolveMaxFeatureNudges(cfg Config) int {
	if cfg.FeatureMaxNudgesSet || cfg.MaxFeatureNudges > 0 {
		if cfg.MaxFeatureNudges < 0 {
			return 0
		}
		return cfg.MaxFeatureNudges
	}
	return 2
}

func registerFeatureTools(registry *tools.Registry, list *features.List, onState func()) error {
	for _, tool := range features.NewTools(list, onState) {
		if registry.Get(tool.Name()) != nil {
			return fmt.Errorf("feature gate tool name conflicts with existing tool: %s", tool.Name())
		}
		if err := registry.Register(tool); err != nil {
			return err
		}
	}
	return nil
}

func initialFeatureMessage(snapshot []features.Feature, maxNudges int) string {
	return fmt.Sprintf("Harness feature-list mode is enabled. The harness owns feature state and will only terminate successfully when every feature is done.\n\nCurrent features:\n%s\n\nUse feature_start to begin one feature at a time. Use feature_complete only after verification, with one evidence entry for each verification item. The harness will reject invalid transitions. Early stop nudges before incomplete termination: %d.", features.Summary(snapshot), maxNudges)
}

func logTerminalStatus(log *transcript.Log, turn int, status string, unfinished []features.Feature, message string) {
	if log == nil {
		return
	}
	log.Append(transcript.EventInfo, turn, map[string]any{
		"event":             "terminal_status",
		"terminal_status":   status,
		"unfinished_count":  len(unfinished),
		"unfinished_detail": features.Summary(unfinished),
		"message":           message,
	})
}
