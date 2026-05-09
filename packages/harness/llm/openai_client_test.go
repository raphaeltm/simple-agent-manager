package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestOpenAIClient_HappyPath(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify request structure.
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/chat/completions" {
			t.Errorf("expected /chat/completions, got %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("expected Bearer test-key, got %s", r.Header.Get("Authorization"))
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("expected application/json, got %s", r.Header.Get("Content-Type"))
		}

		// Verify request body.
		body, _ := io.ReadAll(r.Body)
		var req oaiRequest
		if err := json.Unmarshal(body, &req); err != nil {
			t.Fatalf("failed to parse request: %v", err)
		}
		if req.Model != DefaultModel {
			t.Errorf("expected model %s, got %s", DefaultModel, req.Model)
		}
		if req.Stream {
			t.Error("expected stream=false")
		}

		// Return a text response.
		resp := `{
			"id": "chatcmpl-test",
			"choices": [{
				"index": 0,
				"finish_reason": "stop",
				"message": {
					"role": "assistant",
					"content": "Hello! I can help with that."
				}
			}]
		}`
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(resp))
	}))
	defer server.Close()

	client := NewOpenAIClient(server.URL, "test-key")

	resp, err := client.SendMessage(context.Background(), []Message{
		{Role: RoleUser, Content: "Hello"},
	}, nil)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Content != "Hello! I can help with that." {
		t.Errorf("unexpected content: %q", resp.Content)
	}
	if resp.StopReason != "stop" {
		t.Errorf("unexpected stop reason: %q", resp.StopReason)
	}
	if len(resp.ToolCalls) != 0 {
		t.Errorf("expected no tool calls, got %d", len(resp.ToolCalls))
	}
}

func TestOpenAIClient_ToolCalls(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify tools were sent.
		body, _ := io.ReadAll(r.Body)
		var req oaiRequest
		json.Unmarshal(body, &req)

		if len(req.Tools) != 1 {
			t.Fatalf("expected 1 tool, got %d", len(req.Tools))
		}
		if req.Tools[0].Function.Name != "read_file" {
			t.Errorf("expected tool name read_file, got %s", req.Tools[0].Function.Name)
		}
		if req.ToolChoice != "auto" {
			t.Errorf("expected tool_choice auto for gemma, got %s", req.ToolChoice)
		}

		resp := `{
			"id": "chatcmpl-tc",
			"choices": [{
				"index": 0,
				"finish_reason": "tool_calls",
				"message": {
					"role": "assistant",
					"content": null,
					"tool_calls": [{
						"id": "call_123",
						"type": "function",
						"function": {
							"name": "read_file",
							"arguments": "{\"path\": \"main.go\"}"
						}
					}]
				}
			}]
		}`
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(resp))
	}))
	defer server.Close()

	client := NewOpenAIClient(server.URL, "test-key")

	tools := []ToolDefinition{
		{
			Name:        "read_file",
			Description: "Read a file",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path": map[string]any{"type": "string"},
				},
				"required": []any{"path"},
			},
		},
	}

	resp, err := client.SendMessage(context.Background(), []Message{
		{Role: RoleUser, Content: "Read main.go"},
	}, tools)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.ToolCalls) != 1 {
		t.Fatalf("expected 1 tool call, got %d", len(resp.ToolCalls))
	}
	if resp.ToolCalls[0].ID != "call_123" {
		t.Errorf("unexpected tool call ID: %s", resp.ToolCalls[0].ID)
	}
	if resp.ToolCalls[0].Name != "read_file" {
		t.Errorf("unexpected tool call name: %s", resp.ToolCalls[0].Name)
	}
	if resp.ToolCalls[0].Params["path"] != "main.go" {
		t.Errorf("unexpected tool call params: %v", resp.ToolCalls[0].Params)
	}
	if resp.StopReason != "tool_use" {
		t.Errorf("expected stop_reason tool_use, got %s", resp.StopReason)
	}
}

func TestOpenAIClient_MultipleToolCalls(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := `{
			"id": "chatcmpl-multi",
			"choices": [{
				"index": 0,
				"finish_reason": "tool_calls",
				"message": {
					"role": "assistant",
					"content": "Let me read both files.",
					"tool_calls": [
						{
							"id": "call_1",
							"type": "function",
							"function": {
								"name": "read_file",
								"arguments": "{\"path\": \"a.go\"}"
							}
						},
						{
							"id": "call_2",
							"type": "function",
							"function": {
								"name": "read_file",
								"arguments": "{\"path\": \"b.go\"}"
							}
						}
					]
				}
			}]
		}`
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(resp))
	}))
	defer server.Close()

	client := NewOpenAIClient(server.URL, "test-key")
	resp, err := client.SendMessage(context.Background(), []Message{
		{Role: RoleUser, Content: "Read both files"},
	}, nil)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.ToolCalls) != 2 {
		t.Fatalf("expected 2 tool calls, got %d", len(resp.ToolCalls))
	}
	if resp.Content != "Let me read both files." {
		t.Errorf("expected content to be preserved, got %q", resp.Content)
	}
}

func TestOpenAIClient_ToolResultConversation(t *testing.T) {
	var capturedReq oaiRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &capturedReq)

		resp := `{
			"id": "chatcmpl-done",
			"choices": [{
				"index": 0,
				"finish_reason": "stop",
				"message": {
					"role": "assistant",
					"content": "The file contains a main function."
				}
			}]
		}`
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(resp))
	}))
	defer server.Close()

	client := NewOpenAIClient(server.URL, "test-key")

	// Simulate a conversation with tool results.
	messages := []Message{
		{Role: RoleUser, Content: "Read main.go"},
		{
			Role:    RoleAssistant,
			Content: "",
			ToolCalls: []ToolCall{
				{ID: "call_1", Name: "read_file", Params: map[string]any{"path": "main.go"}},
			},
		},
		{
			Role:       RoleTool,
			ToolResult: &ToolResult{CallID: "call_1", Content: "package main\nfunc main() {}"},
		},
	}

	_, err := client.SendMessage(context.Background(), messages, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify the tool result was converted to tool_call_id format.
	if len(capturedReq.Messages) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(capturedReq.Messages))
	}

	toolMsg := capturedReq.Messages[2]
	if toolMsg.Role != "tool" {
		t.Errorf("expected role tool, got %s", toolMsg.Role)
	}
	if toolMsg.ToolCallID != "call_1" {
		t.Errorf("expected tool_call_id call_1, got %s", toolMsg.ToolCallID)
	}
	if toolMsg.Content == nil || *toolMsg.Content != "package main\nfunc main() {}" {
		t.Errorf("unexpected tool result content: %v", toolMsg.Content)
	}
}

func TestOpenAIClient_QwenWorkarounds(t *testing.T) {
	var capturedReq oaiRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &capturedReq)

		resp := `{
			"id": "chatcmpl-qwen",
			"choices": [{
				"index": 0,
				"finish_reason": "stop",
				"message": {"role": "assistant", "content": "Done"}
			}]
		}`
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(resp))
	}))
	defer server.Close()

	client := NewOpenAIClient(server.URL, "test-key",
		WithModel("@cf/qwen/qwen2.5-coder-32b-instruct"))

	// Send a message with an assistant message that has tool_calls but empty content.
	messages := []Message{
		{Role: RoleUser, Content: "Hello"},
		{
			Role:    RoleAssistant,
			Content: "", // empty content with tool calls
			ToolCalls: []ToolCall{
				{ID: "tc1", Name: "bash", Params: map[string]any{"command": "ls"}},
			},
		},
		{
			Role:       RoleTool,
			ToolResult: &ToolResult{CallID: "tc1", Content: "file1.txt"},
		},
	}

	tools := []ToolDefinition{
		{Name: "bash", Description: "Run command", Parameters: map[string]any{"type": "object"}},
	}

	_, err := client.SendMessage(context.Background(), messages, tools)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify Qwen gets tool_choice: "required".
	if capturedReq.ToolChoice != "required" {
		t.Errorf("expected tool_choice required for qwen, got %s", capturedReq.ToolChoice)
	}

	// Verify empty content becomes "" (not null) for assistant messages with tool_calls.
	assistantMsg := capturedReq.Messages[1]
	if assistantMsg.Content == nil {
		t.Error("expected non-nil content for qwen assistant message with tool_calls")
	} else if *assistantMsg.Content != "" {
		t.Errorf("expected empty string content for qwen, got %q", *assistantMsg.Content)
	}
}

func TestOpenAIClient_GemmaContentNull(t *testing.T) {
	var capturedReq oaiRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &capturedReq)

		resp := `{
			"id": "chatcmpl-gemma",
			"choices": [{
				"index": 0,
				"finish_reason": "stop",
				"message": {"role": "assistant", "content": "Done"}
			}]
		}`
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(resp))
	}))
	defer server.Close()

	// Default model is Gemma.
	client := NewOpenAIClient(server.URL, "test-key")

	messages := []Message{
		{Role: RoleUser, Content: "Hello"},
		{
			Role:    RoleAssistant,
			Content: "", // empty content with tool_calls
			ToolCalls: []ToolCall{
				{ID: "tc1", Name: "bash", Params: map[string]any{"command": "ls"}},
			},
		},
		{
			Role:       RoleTool,
			ToolResult: &ToolResult{CallID: "tc1", Content: "output"},
		},
	}

	_, err := client.SendMessage(context.Background(), messages, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify Gemma gets null content (Content pointer is nil).
	assistantMsg := capturedReq.Messages[1]
	if assistantMsg.Content != nil {
		t.Errorf("expected nil content for gemma assistant message with tool_calls, got %q", *assistantMsg.Content)
	}
}

func TestOpenAIClient_HTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"error":{"message":"Rate limit exceeded","type":"rate_limit_error","code":"rate_limit"}}`))
	}))
	defer server.Close()

	client := NewOpenAIClient(server.URL, "test-key")
	_, err := client.SendMessage(context.Background(), []Message{
		{Role: RoleUser, Content: "Hello"},
	}, nil)

	if err == nil {
		t.Fatal("expected error for 429 response")
	}
	if !strings.Contains(err.Error(), "Rate limit exceeded") {
		t.Errorf("expected rate limit error message, got: %v", err)
	}
	if !strings.Contains(err.Error(), "429") {
		t.Errorf("expected status code in error, got: %v", err)
	}
}

func TestOpenAIClient_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("Internal Server Error"))
	}))
	defer server.Close()

	client := NewOpenAIClient(server.URL, "test-key")
	_, err := client.SendMessage(context.Background(), []Message{
		{Role: RoleUser, Content: "Hello"},
	}, nil)

	if err == nil {
		t.Fatal("expected error for 500 response")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Errorf("expected status code in error, got: %v", err)
	}
}

func TestOpenAIClient_InvalidJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("not json"))
	}))
	defer server.Close()

	client := NewOpenAIClient(server.URL, "test-key")
	_, err := client.SendMessage(context.Background(), []Message{
		{Role: RoleUser, Content: "Hello"},
	}, nil)

	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
	if !strings.Contains(err.Error(), "parse response") {
		t.Errorf("expected parse error, got: %v", err)
	}
}

func TestOpenAIClient_EmptyChoices(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"test","choices":[]}`))
	}))
	defer server.Close()

	client := NewOpenAIClient(server.URL, "test-key")
	_, err := client.SendMessage(context.Background(), []Message{
		{Role: RoleUser, Content: "Hello"},
	}, nil)

	if err == nil {
		t.Fatal("expected error for empty choices")
	}
	if !strings.Contains(err.Error(), "no choices") {
		t.Errorf("expected no choices error, got: %v", err)
	}
}

func TestOpenAIClient_ContextCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Delay response to trigger context cancellation.
		time.Sleep(2 * time.Second)
		w.Write([]byte(`{"choices":[{"message":{"content":"late"}}]}`))
	}))
	defer server.Close()

	client := NewOpenAIClient(server.URL, "test-key")

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	_, err := client.SendMessage(ctx, []Message{
		{Role: RoleUser, Content: "Hello"},
	}, nil)

	if err == nil {
		t.Fatal("expected error on context cancellation")
	}
}

func TestOpenAIClient_CustomModel(t *testing.T) {
	var capturedModel string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req oaiRequest
		json.Unmarshal(body, &req)
		capturedModel = req.Model

		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"test","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer server.Close()

	client := NewOpenAIClient(server.URL, "test-key", WithModel("gpt-4.1-mini"))
	_, err := client.SendMessage(context.Background(), []Message{
		{Role: RoleUser, Content: "Hello"},
	}, nil)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capturedModel != "gpt-4.1-mini" {
		t.Errorf("expected model gpt-4.1-mini, got %s", capturedModel)
	}
}

func TestOpenAIClient_BaseURLTrailingSlash(t *testing.T) {
	var capturedPath string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"test","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer server.Close()

	// Add trailing slash to base URL.
	client := NewOpenAIClient(server.URL+"/", "test-key")
	_, err := client.SendMessage(context.Background(), []Message{
		{Role: RoleUser, Content: "Hello"},
	}, nil)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capturedPath != "/chat/completions" {
		t.Errorf("expected /chat/completions, got %s (double slash?)", capturedPath)
	}
}

func TestOpenAIClient_InvalidToolCallArgs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Return tool_calls with invalid JSON arguments.
		resp := `{
			"id": "test",
			"choices": [{
				"index": 0,
				"finish_reason": "tool_calls",
				"message": {
					"role": "assistant",
					"content": null,
					"tool_calls": [{
						"id": "call_bad",
						"type": "function",
						"function": {
							"name": "bash",
							"arguments": "not valid json"
						}
					}]
				}
			}]
		}`
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(resp))
	}))
	defer server.Close()

	client := NewOpenAIClient(server.URL, "test-key")
	resp, err := client.SendMessage(context.Background(), []Message{
		{Role: RoleUser, Content: "run something"},
	}, nil)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Invalid args should be wrapped in _raw field.
	if resp.ToolCalls[0].Params["_raw"] != "not valid json" {
		t.Errorf("expected _raw fallback, got %v", resp.ToolCalls[0].Params)
	}
}

func TestOpenAIClient_SystemMessage(t *testing.T) {
	var capturedReq oaiRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &capturedReq)

		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"test","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer server.Close()

	client := NewOpenAIClient(server.URL, "test-key")
	_, err := client.SendMessage(context.Background(), []Message{
		{Role: RoleSystem, Content: "You are a coding assistant."},
		{Role: RoleUser, Content: "Hello"},
	}, nil)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(capturedReq.Messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(capturedReq.Messages))
	}
	if capturedReq.Messages[0].Role != "system" {
		t.Errorf("expected system role, got %s", capturedReq.Messages[0].Role)
	}
}

func TestIsQwenModel(t *testing.T) {
	tests := []struct {
		model string
		want  bool
	}{
		{"@cf/google/gemma-4-26b-a4b-it", false},
		{"@cf/qwen/qwen2.5-coder-32b-instruct", true},
		{"@cf/qwen/qwen3-30b-a3b-fp8", true},
		{"gpt-4.1-mini", false},
		{"claude-haiku-4-5-20251001", false},
	}

	for _, tt := range tests {
		c := &OpenAIClient{model: tt.model}
		if got := c.isQwenModel(); got != tt.want {
			t.Errorf("isQwenModel(%q) = %v, want %v", tt.model, got, tt.want)
		}
	}
}
