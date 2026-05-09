package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAdaptTools(t *testing.T) {
	srv := newMockMCPServer(t, func(req jsonRPCRequest) (any, *jsonRPCError) {
		return MCPToolResult{
			Content: []MCPContent{{Type: "text", Text: "ok"}},
		}, nil
	})
	defer srv.Close()

	client := NewClient(srv.URL, "test-token")
	mcpDefs := []MCPToolDef{
		{
			Name:        "get_task_details",
			Description: "Get details of a task",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"taskId": map[string]any{"type": "string"},
				},
				"required": []any{"taskId"},
			},
		},
		{
			Name:        "search_knowledge",
			Description: "Search the knowledge graph",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"query": map[string]any{"type": "string"},
				},
			},
		},
	}

	adapted := AdaptTools(client, mcpDefs)

	if len(adapted) != 2 {
		t.Fatalf("expected 2 adapted tools, got %d", len(adapted))
	}

	// Verify tool interface methods.
	tool := adapted[0]
	if tool.Name() != "get_task_details" {
		t.Errorf("expected name 'get_task_details', got %q", tool.Name())
	}
	if tool.Description() != "Get details of a task" {
		t.Errorf("unexpected description: %q", tool.Description())
	}

	schema := tool.Schema()
	if schema["type"] != "object" {
		t.Errorf("expected schema type 'object', got %v", schema["type"])
	}
}

func TestAdaptToolExecute(t *testing.T) {
	srv := newMockMCPServer(t, func(req jsonRPCRequest) (any, *jsonRPCError) {
		// Verify we received the right method and args.
		if req.Method != "tools/call" {
			return nil, &jsonRPCError{Code: -32601, Message: "unexpected method"}
		}

		// Parse params to verify tool name.
		raw, _ := json.Marshal(req.Params)
		var params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		json.Unmarshal(raw, &params)

		if params.Name != "get_task_details" {
			return nil, &jsonRPCError{Code: -32000, Message: "wrong tool name"}
		}

		return MCPToolResult{
			Content: []MCPContent{
				{Type: "text", Text: "Task: Build MCP client"},
				{Type: "text", Text: "Status: in_progress"},
			},
		}, nil
	})
	defer srv.Close()

	client := NewClient(srv.URL, "test-token")
	mcpDefs := []MCPToolDef{
		{Name: "get_task_details", Description: "Get task details", InputSchema: map[string]any{"type": "object"}},
	}

	adapted := AdaptTools(client, mcpDefs)
	result, err := adapted[0].Execute(context.Background(), map[string]any{"taskId": "task-1"})
	if err != nil {
		t.Fatalf("Execute error: %v", err)
	}

	if result != "Task: Build MCP client\nStatus: in_progress" {
		t.Errorf("unexpected result: %q", result)
	}
}

func TestAdaptToolExecuteError(t *testing.T) {
	srv := newMockMCPServer(t, func(req jsonRPCRequest) (any, *jsonRPCError) {
		return MCPToolResult{
			Content: []MCPContent{{Type: "text", Text: "tool failed: invalid args"}},
			IsError: true,
		}, nil
	})
	defer srv.Close()

	client := NewClient(srv.URL, "test-token")
	mcpDefs := []MCPToolDef{
		{Name: "bad_tool", Description: "A failing tool", InputSchema: map[string]any{"type": "object"}},
	}

	adapted := AdaptTools(client, mcpDefs)
	result, err := adapted[0].Execute(context.Background(), nil)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	// Should still return the error text from the MCP result.
	if result != "tool failed: invalid args" {
		t.Errorf("expected error text in result, got: %q", result)
	}
}

func TestAdaptToolsEmpty(t *testing.T) {
	client := NewClient("http://unused", "token")
	adapted := AdaptTools(client, nil)
	if len(adapted) != 0 {
		t.Errorf("expected 0 adapted tools, got %d", len(adapted))
	}
}

func TestFormatMCPResult(t *testing.T) {
	tests := []struct {
		name     string
		result   *MCPToolResult
		expected string
	}{
		{
			name:     "empty content",
			result:   &MCPToolResult{Content: nil},
			expected: "",
		},
		{
			name: "single item",
			result: &MCPToolResult{
				Content: []MCPContent{{Type: "text", Text: "hello"}},
			},
			expected: "hello",
		},
		{
			name: "multiple items",
			result: &MCPToolResult{
				Content: []MCPContent{
					{Type: "text", Text: "line1"},
					{Type: "text", Text: "line2"},
				},
			},
			expected: "line1\nline2",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := formatMCPResult(tt.result)
			if got != tt.expected {
				t.Errorf("expected %q, got %q", tt.expected, got)
			}
		})
	}
}

// TestAdaptToolVerifiesCallToolArgs ensures the adapted tool passes the correct
// tool name and arguments through to the MCP client's CallTool.
func TestAdaptToolVerifiesCallToolArgs(t *testing.T) {
	var receivedMethod string
	var receivedParams map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var rpcReq jsonRPCRequest
		json.Unmarshal(body, &rpcReq)
		receivedMethod = rpcReq.Method

		raw, _ := json.Marshal(rpcReq.Params)
		json.Unmarshal(raw, &receivedParams)

		result, _ := json.Marshal(MCPToolResult{
			Content: []MCPContent{{Type: "text", Text: "ok"}},
		})
		resp := jsonRPCResponse{JSONRPC: "2.0", ID: rpcReq.ID, Result: result}
		w.Header().Set("Content-Type", "text/event-stream")
		respBytes, _ := json.Marshal(resp)
		fmt.Fprintf(w, "data: %s\n\n", respBytes)
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "test-token")
	mcpDefs := []MCPToolDef{
		{Name: "dispatch_task", Description: "Dispatch a task", InputSchema: map[string]any{"type": "object"}},
	}
	adapted := AdaptTools(client, mcpDefs)

	_, err := adapted[0].Execute(context.Background(), map[string]any{
		"title":       "Test task",
		"description": "A test",
	})
	if err != nil {
		t.Fatalf("Execute error: %v", err)
	}

	if receivedMethod != "tools/call" {
		t.Errorf("expected method 'tools/call', got %q", receivedMethod)
	}
	if receivedParams["name"] != "dispatch_task" {
		t.Errorf("expected tool name 'dispatch_task', got %v", receivedParams["name"])
	}
}
