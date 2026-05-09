package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// newMockMCPServer creates an httptest server that returns scripted responses.
// handler receives the parsed JSON-RPC request and returns the result to embed
// in the response.
func newMockMCPServer(t *testing.T, handler func(req jsonRPCRequest) (any, *jsonRPCError)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}

		var rpcReq jsonRPCRequest
		if err := json.Unmarshal(body, &rpcReq); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}

		// Verify auth header.
		auth := r.Header.Get("Authorization")
		if auth == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		result, rpcErr := handler(rpcReq)

		// Respond as SSE by default (matching MCP server behavior).
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)

		var resp jsonRPCResponse
		resp.JSONRPC = "2.0"
		resp.ID = rpcReq.ID
		if rpcErr != nil {
			resp.Error = rpcErr
		} else {
			raw, _ := json.Marshal(result)
			resp.Result = raw
		}

		respBytes, _ := json.Marshal(resp)
		fmt.Fprintf(w, "data: %s\n\n", respBytes)
	}))
}

func TestListTools(t *testing.T) {
	tools := []MCPToolDef{
		{Name: "get_task_details", Description: "Get task details", InputSchema: map[string]any{"type": "object"}},
		{Name: "dispatch_task", Description: "Dispatch a task", InputSchema: map[string]any{"type": "object"}},
	}

	srv := newMockMCPServer(t, func(req jsonRPCRequest) (any, *jsonRPCError) {
		if req.Method != "tools/list" {
			return nil, &jsonRPCError{Code: -32601, Message: "method not found"}
		}
		return map[string]any{"tools": tools}, nil
	})
	defer srv.Close()

	client := NewClient(srv.URL, "test-token")
	result, err := client.ListTools(context.Background())
	if err != nil {
		t.Fatalf("ListTools error: %v", err)
	}

	if len(result) != 2 {
		t.Fatalf("expected 2 tools, got %d", len(result))
	}
	if result[0].Name != "get_task_details" {
		t.Errorf("expected tool name 'get_task_details', got %q", result[0].Name)
	}
	if result[1].Name != "dispatch_task" {
		t.Errorf("expected tool name 'dispatch_task', got %q", result[1].Name)
	}
}

func TestCallTool(t *testing.T) {
	srv := newMockMCPServer(t, func(req jsonRPCRequest) (any, *jsonRPCError) {
		if req.Method != "tools/call" {
			return nil, &jsonRPCError{Code: -32601, Message: "method not found"}
		}
		return MCPToolResult{
			Content: []MCPContent{
				{Type: "text", Text: "task completed successfully"},
			},
		}, nil
	})
	defer srv.Close()

	client := NewClient(srv.URL, "test-token")
	result, err := client.CallTool(context.Background(), "complete_task", map[string]any{
		"taskId":  "task-123",
		"summary": "done",
	})
	if err != nil {
		t.Fatalf("CallTool error: %v", err)
	}

	if result.IsError {
		t.Error("expected IsError=false")
	}
	if len(result.Content) != 1 {
		t.Fatalf("expected 1 content item, got %d", len(result.Content))
	}
	if result.Content[0].Text != "task completed successfully" {
		t.Errorf("unexpected text: %q", result.Content[0].Text)
	}
}

func TestCallToolError(t *testing.T) {
	srv := newMockMCPServer(t, func(req jsonRPCRequest) (any, *jsonRPCError) {
		return nil, &jsonRPCError{Code: -32000, Message: "tool not found: bad_tool"}
	})
	defer srv.Close()

	client := NewClient(srv.URL, "test-token")
	_, err := client.CallTool(context.Background(), "bad_tool", nil)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "tool not found") {
		t.Errorf("expected 'tool not found' in error, got: %v", err)
	}
}

func TestHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "internal error", http.StatusInternalServerError)
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "test-token")
	_, err := client.ListTools(context.Background())
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "HTTP 500") {
		t.Errorf("expected HTTP 500 in error, got: %v", err)
	}
}

func TestUnauthorized(t *testing.T) {
	srv := newMockMCPServer(t, func(req jsonRPCRequest) (any, *jsonRPCError) {
		return nil, nil
	})
	defer srv.Close()

	// Client with no token — server will reject.
	client := NewClient(srv.URL, "")
	_, err := client.ListTools(context.Background())
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "HTTP 401") {
		t.Errorf("expected HTTP 401 in error, got: %v", err)
	}
}

func TestContextCancellation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Simulate slow server — delay long enough for client context to cancel.
		time.Sleep(2 * time.Second)
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "test-token")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	_, err := client.ListTools(ctx)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestPlainJSONResponse(t *testing.T) {
	// Some MCP servers may respond with plain JSON instead of SSE.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var rpcReq jsonRPCRequest
		json.Unmarshal(body, &rpcReq)

		result, _ := json.Marshal(map[string]any{
			"tools": []MCPToolDef{
				{Name: "test_tool", Description: "A test tool"},
			},
		})

		resp := jsonRPCResponse{
			JSONRPC: "2.0",
			ID:      rpcReq.ID,
			Result:  result,
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "test-token")
	tools, err := client.ListTools(context.Background())
	if err != nil {
		t.Fatalf("ListTools error: %v", err)
	}
	if len(tools) != 1 || tools[0].Name != "test_tool" {
		t.Errorf("unexpected tools: %+v", tools)
	}
}

func TestMultipleSSEEvents(t *testing.T) {
	// Server sends multiple SSE events; only the matching ID should be used.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var rpcReq jsonRPCRequest
		json.Unmarshal(body, &rpcReq)

		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)

		// Send a notification (no matching ID).
		notif, _ := json.Marshal(jsonRPCResponse{JSONRPC: "2.0", ID: 9999})
		fmt.Fprintf(w, "data: %s\n\n", notif)

		// Send the real response.
		result, _ := json.Marshal(map[string]any{
			"tools": []MCPToolDef{{Name: "real_tool", Description: "The real tool"}},
		})
		resp := jsonRPCResponse{JSONRPC: "2.0", ID: rpcReq.ID, Result: result}
		respBytes, _ := json.Marshal(resp)
		fmt.Fprintf(w, "data: %s\n\n", respBytes)
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "test-token")
	tools, err := client.ListTools(context.Background())
	if err != nil {
		t.Fatalf("ListTools error: %v", err)
	}
	if len(tools) != 1 || tools[0].Name != "real_tool" {
		t.Errorf("unexpected tools: %+v", tools)
	}
}
