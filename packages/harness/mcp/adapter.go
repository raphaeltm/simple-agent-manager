package mcp

import (
	"context"
	"fmt"
	"strings"

	"github.com/workspace/harness/tools"
)

// mcpTool wraps an MCP tool definition as a harness tools.Tool, delegating
// execution to the MCP client.
type mcpTool struct {
	client      *Client
	name        string
	description string
	inputSchema map[string]any
}

var _ tools.Tool = (*mcpTool)(nil)

func (t *mcpTool) Name() string             { return t.name }
func (t *mcpTool) Description() string       { return t.description }
func (t *mcpTool) Schema() map[string]any    { return t.inputSchema }

func (t *mcpTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	result, err := t.client.CallTool(ctx, t.name, params)
	if err != nil {
		return "", err
	}
	text := formatMCPResult(result)
	if result.IsError {
		return text, fmt.Errorf("MCP tool %s returned error", t.name)
	}
	return text, nil
}

// AdaptTools converts MCP tool definitions into harness tools.Tool instances
// that delegate execution to the given MCP client.
func AdaptTools(client *Client, mcpTools []MCPToolDef) []tools.Tool {
	adapted := make([]tools.Tool, len(mcpTools))
	for i, def := range mcpTools {
		adapted[i] = &mcpTool{
			client:      client,
			name:        def.Name,
			description: def.Description,
			inputSchema: def.InputSchema,
		}
	}
	return adapted
}

// formatMCPResult concatenates MCP content items into a single string.
func formatMCPResult(result *MCPToolResult) string {
	if len(result.Content) == 0 {
		return ""
	}
	var b strings.Builder
	for i, c := range result.Content {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(c.Text)
	}
	return b.String()
}
