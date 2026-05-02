// Package llm provides the LLM provider abstraction for the SAM agent harness.
package llm

import "context"

// Role represents a message role in the conversation.
type Role string

const (
	RoleSystem    Role = "system"
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleTool      Role = "tool"
)

// Message represents a single message in the conversation.
type Message struct {
	Role       Role         `json:"role"`
	Content    string       `json:"content,omitempty"`
	ToolCalls  []ToolCall   `json:"tool_calls,omitempty"`
	ToolResult *ToolResult  `json:"tool_result,omitempty"`
}

// ToolCall represents an LLM request to invoke a tool.
type ToolCall struct {
	ID     string         `json:"id"`
	Name   string         `json:"name"`
	Params map[string]any `json:"params"`
}

// ToolResult represents the output of a tool execution.
type ToolResult struct {
	CallID  string `json:"call_id"`
	Content string `json:"content"`
	IsError bool   `json:"is_error,omitempty"`
}

// ToolDefinition describes a tool available to the LLM.
type ToolDefinition struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"` // JSON Schema object
}

// Response represents an LLM response.
type Response struct {
	Content   string     `json:"content,omitempty"`
	ToolCalls []ToolCall `json:"tool_calls,omitempty"`
	// StopReason indicates why the model stopped generating.
	StopReason string `json:"stop_reason,omitempty"`
}

// Provider is the interface that LLM backends must implement.
type Provider interface {
	// SendMessage sends a conversation to the LLM and returns its response.
	SendMessage(ctx context.Context, messages []Message, tools []ToolDefinition) (*Response, error)
}
