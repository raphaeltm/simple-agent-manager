package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOpenAIProxyProviderSendsSAMProxyRequest(t *testing.T) {
	var gotAuth string
	var gotPath string
	var gotBody openAIChatRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"choices": [{
				"message": {
					"role": "assistant",
					"content": "",
					"tool_calls": [{
						"id": "call_1",
						"type": "function",
						"function": {
							"name": "read_file",
							"arguments": "{\"path\":\"README.md\"}"
						}
					}]
				},
				"finish_reason": "tool_calls"
			}]
		}`))
	}))
	defer server.Close()

	provider, err := NewOpenAIProxyProvider(OpenAIProxyConfig{
		BaseURL:    server.URL,
		APIKey:     "workspace-callback-token",
		Model:      "@cf/google/gemma-3-12b-it",
		ToolChoice: "required",
	})
	if err != nil {
		t.Fatalf("provider: %v", err)
	}

	resp, err := provider.SendMessage(context.Background(), []Message{
		{Role: RoleSystem, Content: "Use tools."},
		{Role: RoleUser, Content: "Read the README."},
	}, []ToolDefinition{
		{
			Name:        "read_file",
			Description: "Read a file",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path": map[string]any{"type": "string"},
				},
				"required": []string{"path"},
			},
		},
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	if gotAuth != "Bearer workspace-callback-token" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
	if gotPath != "/chat/completions" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotBody.Model != "@cf/google/gemma-3-12b-it" {
		t.Fatalf("model = %q", gotBody.Model)
	}
	if gotBody.ToolChoice != "required" {
		t.Fatalf("tool_choice = %q", gotBody.ToolChoice)
	}
	if len(gotBody.Tools) != 1 || gotBody.Tools[0].Function.Name != "read_file" {
		t.Fatalf("tools = %#v", gotBody.Tools)
	}
	if len(resp.ToolCalls) != 1 {
		t.Fatalf("tool calls = %#v", resp.ToolCalls)
	}
	if resp.ToolCalls[0].Name != "read_file" || resp.ToolCalls[0].Params["path"] != "README.md" {
		t.Fatalf("tool call = %#v", resp.ToolCalls[0])
	}
}

func TestOpenAIProxyProviderSendsToolResults(t *testing.T) {
	var gotBody openAIChatRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"choices": [{
				"message": {"role": "assistant", "content": "Done."},
				"finish_reason": "stop"
			}]
		}`))
	}))
	defer server.Close()

	provider, err := NewOpenAIProxyProvider(OpenAIProxyConfig{
		BaseURL: server.URL,
		APIKey:  "workspace-callback-token",
		Model:   "gpt-4.1-mini",
	})
	if err != nil {
		t.Fatalf("provider: %v", err)
	}

	resp, err := provider.SendMessage(context.Background(), []Message{
		{
			Role: RoleAssistant,
			ToolCalls: []ToolCall{{
				ID:     "call_1",
				Name:   "bash",
				Params: map[string]any{"command": "go test ./..."},
			}},
		},
		{
			Role: RoleTool,
			ToolResult: &ToolResult{
				CallID:  "call_1",
				Content: "ok",
			},
		},
	}, nil)
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	if resp.Content != "Done." {
		t.Fatalf("content = %q", resp.Content)
	}
	if len(gotBody.Messages) != 2 {
		t.Fatalf("messages = %#v", gotBody.Messages)
	}
	if gotBody.Messages[0].Content != "" {
		t.Fatalf("assistant tool-call content should be empty string, got %q", gotBody.Messages[0].Content)
	}
	if len(gotBody.Messages[0].ToolCalls) != 1 {
		t.Fatalf("assistant tool calls = %#v", gotBody.Messages[0].ToolCalls)
	}
	if gotBody.Messages[1].Role != "tool" || gotBody.Messages[1].ToolCallID != "call_1" || gotBody.Messages[1].Content != "ok" {
		t.Fatalf("tool message = %#v", gotBody.Messages[1])
	}
}
