// Package tools provides the tool registry and built-in tools for the SAM agent harness.
package tools

import (
	"context"
	"fmt"
	"sync"

	"github.com/workspace/harness/llm"
)

// Tool is the interface that all agent tools must implement.
type Tool interface {
	// Name returns the tool's unique identifier.
	Name() string
	// Description returns a human-readable description for the LLM.
	Description() string
	// Schema returns the JSON Schema for the tool's parameters.
	Schema() map[string]any
	// Execute runs the tool with the given parameters.
	Execute(ctx context.Context, params map[string]any) (string, error)
}

// Registry manages tool registration and dispatch.
type Registry struct {
	mu    sync.RWMutex
	tools map[string]Tool
}

// NewRegistry creates an empty tool registry.
func NewRegistry() *Registry {
	return &Registry{tools: make(map[string]Tool)}
}

// Register adds a tool to the registry. Returns an error if the name is already taken.
func (r *Registry) Register(tool Tool) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	name := tool.Name()
	if _, exists := r.tools[name]; exists {
		return fmt.Errorf("tool already registered: %s", name)
	}
	r.tools[name] = tool
	return nil
}

// Dispatch executes a tool call and returns the result.
func (r *Registry) Dispatch(ctx context.Context, call llm.ToolCall) llm.ToolResult {
	r.mu.RLock()
	tool, ok := r.tools[call.Name]
	r.mu.RUnlock()

	if !ok {
		return llm.ToolResult{
			CallID:  call.ID,
			Content: fmt.Sprintf("error: unknown tool %q", call.Name),
			IsError: true,
		}
	}

	result, err := tool.Execute(ctx, call.Params)
	if err != nil {
		content := fmt.Sprintf("error: %s", err.Error())
		// If the tool returned partial output alongside an error (e.g., bash
		// with non-zero exit), prefer the richer output.
		if result != "" {
			content = result
		}
		return llm.ToolResult{
			CallID:  call.ID,
			Content: content,
			IsError: true,
		}
	}
	return llm.ToolResult{
		CallID:  call.ID,
		Content: result,
	}
}

// Definitions returns the LLM-compatible tool definitions for all registered tools.
func (r *Registry) Definitions() []llm.ToolDefinition {
	r.mu.RLock()
	defer r.mu.RUnlock()

	defs := make([]llm.ToolDefinition, 0, len(r.tools))
	for _, t := range r.tools {
		defs = append(defs, llm.ToolDefinition{
			Name:        t.Name(),
			Description: t.Description(),
			Parameters:  t.Schema(),
		})
	}
	return defs
}

// Names returns the names of all registered tools.
func (r *Registry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	names := make([]string, 0, len(r.tools))
	for name := range r.tools {
		names = append(names, name)
	}
	return names
}
