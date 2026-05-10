// Package llm provides streaming support for LLM providers.
package llm

import (
	"bufio"
	"context"
	"io"
	"strings"
)

// StreamEvent represents a single event from a streaming LLM response.
type StreamEvent struct {
	// Type identifies the event kind.
	Type StreamEventType

	// Delta is the incremental text content (for ContentDelta events).
	Delta string

	// ToolCall is populated for ToolCallStart and ToolCallDelta events.
	ToolCall *ToolCallDelta

	// Usage is populated for the final Done event.
	Usage *Usage

	// Error is populated for Error events.
	Error error
}

// StreamEventType identifies the kind of streaming event.
type StreamEventType int

const (
	// EventContentDelta is an incremental text token.
	EventContentDelta StreamEventType = iota
	// EventToolCallStart signals a new tool call is beginning.
	EventToolCallStart
	// EventToolCallDelta is an incremental tool call argument fragment.
	EventToolCallDelta
	// EventDone signals the stream is complete.
	EventDone
	// EventError signals a stream-level error.
	EventError
)

// ToolCallDelta holds incremental tool call information.
type ToolCallDelta struct {
	// Index is the tool call index within the response (for parallel tool calls).
	Index int
	// ID is the tool call ID (set on ToolCallStart, empty on deltas).
	ID string
	// Name is the tool name (set on ToolCallStart, empty on deltas).
	Name string
	// ArgumentsDelta is the incremental JSON fragment for arguments.
	ArgumentsDelta string
}

// Usage tracks token consumption.
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`

	// Anthropic cache fields (zero if not applicable).
	CacheCreationInputTokens int `json:"cache_creation_input_tokens,omitempty"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens,omitempty"`
}

// StreamProvider extends Provider with streaming support.
// Implementations that support streaming should implement this interface.
// The agent loop checks for StreamProvider at runtime and falls back to
// the non-streaming Provider.SendMessage if not available.
type StreamProvider interface {
	Provider

	// SendMessageStream sends a conversation to the LLM and returns a channel
	// of streaming events. The channel is closed when the stream completes or
	// errors. The caller should range over the channel until it closes.
	// The final event will be EventDone (with Usage) or EventError.
	SendMessageStream(ctx context.Context, messages []Message, tools []ToolDefinition) (<-chan StreamEvent, error)
}

// CollectStream reads all events from a stream channel and assembles them
// into a complete Response. This is useful for testing or when streaming
// display is not needed but you want to use a StreamProvider.
func CollectStream(events <-chan StreamEvent) (*Response, error) {
	var (
		content    strings.Builder
		toolCalls  []ToolCall
		stopReason string
		usage      *Usage

		// Track in-progress tool calls by index.
		pendingCalls = map[int]*strings.Builder{}
		callMeta     = map[int]ToolCall{} // ID and Name by index
	)

	for ev := range events {
		switch ev.Type {
		case EventContentDelta:
			content.WriteString(ev.Delta)

		case EventToolCallStart:
			if ev.ToolCall != nil {
				idx := ev.ToolCall.Index
				pendingCalls[idx] = &strings.Builder{}
				callMeta[idx] = ToolCall{
					ID:   ev.ToolCall.ID,
					Name: ev.ToolCall.Name,
				}
			}

		case EventToolCallDelta:
			if ev.ToolCall != nil {
				if b, ok := pendingCalls[ev.ToolCall.Index]; ok {
					b.WriteString(ev.ToolCall.ArgumentsDelta)
				}
			}

		case EventDone:
			stopReason = "end_turn"
			if ev.Usage != nil {
				usage = ev.Usage
			}

		case EventError:
			return nil, ev.Error
		}
	}

	// Assemble completed tool calls.
	for idx, builder := range pendingCalls {
		tc := callMeta[idx]
		argsJSON := builder.String()
		if argsJSON != "" {
			tc.Params = parseJSONParams(argsJSON)
		}
		if tc.Params == nil {
			tc.Params = map[string]any{}
		}
		toolCalls = append(toolCalls, tc)
	}

	if len(toolCalls) > 0 {
		stopReason = "tool_use"
	} else if stopReason == "" {
		stopReason = "complete"
	}

	resp := &Response{
		Content:    content.String(),
		ToolCalls:  toolCalls,
		StopReason: stopReason,
	}
	if usage != nil {
		resp.Usage = usage
	}

	return resp, nil
}

// parseJSONParams parses a JSON string into a map. On failure, wraps as _raw.
func parseJSONParams(s string) map[string]any {
	var params map[string]any
	if err := jsonUnmarshal([]byte(s), &params); err != nil {
		return map[string]any{"_raw": s}
	}
	return params
}

// newLineScanner creates a buffered scanner for reading lines from SSE streams.
func newLineScanner(r io.Reader) *bufio.Scanner {
	scanner := bufio.NewScanner(r)
	// Allow large lines (some tool call arguments can be big).
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	return scanner
}

// parseSSELines parses Server-Sent Events from a reader, calling the handler
// for each data line. Returns when the reader is exhausted or ctx is cancelled.
func parseSSELines(ctx context.Context, r io.Reader, handler func(data string) bool) error {
	scanner := newLineScanner(r)

	for scanner.Scan() {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		line := scanner.Text()

		// SSE data lines start with "data: ".
		if !strings.HasPrefix(line, "data: ") {
			continue
		}

		data := strings.TrimPrefix(line, "data: ")

		// "[DONE]" is the OpenAI termination signal.
		if data == "[DONE]" {
			return nil
		}

		// Call handler. If it returns false, stop parsing.
		if !handler(data) {
			return nil
		}
	}

	return scanner.Err()
}
