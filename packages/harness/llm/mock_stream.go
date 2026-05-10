package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
)

// MockStreamProvider extends MockProvider with streaming support.
// It converts each scripted Response into a sequence of StreamEvents.
type MockStreamProvider struct {
	mu        sync.Mutex
	responses []*Response
	calls     [][]Message
	index     int
}

// NewMockStreamProvider creates a MockStreamProvider with scripted responses.
func NewMockStreamProvider(responses ...*Response) *MockStreamProvider {
	return &MockStreamProvider{responses: responses}
}

// SendMessage returns the next scripted response (non-streaming fallback).
func (m *MockStreamProvider) SendMessage(ctx context.Context, messages []Message, tools []ToolDefinition) (*Response, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, messages)
	if m.index >= len(m.responses) {
		return nil, fmt.Errorf("mock stream provider: no more responses")
	}
	resp := m.responses[m.index]
	m.index++
	return resp, nil
}

// SendMessageStream returns a channel that emits the next scripted response as StreamEvents.
func (m *MockStreamProvider) SendMessageStream(ctx context.Context, messages []Message, tools []ToolDefinition) (<-chan StreamEvent, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, messages)
	if m.index >= len(m.responses) {
		return nil, fmt.Errorf("mock stream provider: no more responses")
	}
	resp := m.responses[m.index]
	m.index++

	ch := make(chan StreamEvent, 32)
	go func() {
		defer close(ch)

		// Emit content as token-sized deltas.
		if resp.Content != "" {
			for i := 0; i < len(resp.Content); i += 5 {
				end := i + 5
				if end > len(resp.Content) {
					end = len(resp.Content)
				}
				ch <- StreamEvent{Type: EventContentDelta, Delta: resp.Content[i:end]}
			}
		}

		// Emit tool calls.
		for idx, tc := range resp.ToolCalls {
			ch <- StreamEvent{
				Type: EventToolCallStart,
				ToolCall: &ToolCallDelta{
					Index: idx,
					ID:    tc.ID,
					Name:  tc.Name,
				},
			}
			// Serialize params as a single chunk.
			if tc.Params != nil {
				args, _ := json.Marshal(tc.Params)
				ch <- StreamEvent{
					Type: EventToolCallDelta,
					ToolCall: &ToolCallDelta{
						Index:          idx,
						ArgumentsDelta: string(args),
					},
				}
			}
		}

		ch <- StreamEvent{Type: EventDone, Usage: resp.Usage}
	}()

	return ch, nil
}

// CallCount returns the number of calls made.
func (m *MockStreamProvider) CallCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.calls)
}
