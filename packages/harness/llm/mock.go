package llm

import (
	"context"
	"fmt"
	"sync"
)

// MockProvider is a deterministic LLM provider for testing.
// It returns pre-scripted responses in order.
type MockProvider struct {
	mu        sync.Mutex
	responses []*Response
	calls     [][]Message // record of all calls made
	index     int
}

// NewMockProvider creates a MockProvider with the given scripted responses.
// Each call to SendMessage returns the next response in order.
func NewMockProvider(responses ...*Response) *MockProvider {
	return &MockProvider{responses: responses}
}

// SendMessage returns the next scripted response.
func (m *MockProvider) SendMessage(ctx context.Context, messages []Message, tools []ToolDefinition) (*Response, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.calls = append(m.calls, messages)

	if m.index >= len(m.responses) {
		return nil, fmt.Errorf("mock provider: no more scripted responses (called %d times, have %d responses)", m.index+1, len(m.responses))
	}

	resp := m.responses[m.index]
	m.index++
	return resp, nil
}

// CallCount returns the number of times SendMessage was called.
func (m *MockProvider) CallCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.calls)
}

// CallMessages returns the messages from the nth call (0-indexed).
func (m *MockProvider) CallMessages(n int) []Message {
	m.mu.Lock()
	defer m.mu.Unlock()
	if n >= len(m.calls) {
		return nil
	}
	return m.calls[n]
}
