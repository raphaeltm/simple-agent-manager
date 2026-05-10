package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBuildRequest_SystemPromptCached(t *testing.T) {
	c := NewAnthropicClient("http://localhost", "sk-test")

	messages := []Message{
		{Role: RoleSystem, Content: "You are a helpful assistant."},
		{Role: RoleUser, Content: "Hello"},
	}

	req := c.buildRequest(messages, nil)

	if len(req.System) != 1 {
		t.Fatalf("expected 1 system block, got %d", len(req.System))
	}
	block := req.System[0]
	if block.Type != "text" {
		t.Errorf("expected type 'text', got %q", block.Type)
	}
	if block.Text != "You are a helpful assistant." {
		t.Errorf("unexpected system text: %q", block.Text)
	}
	if block.CacheControl == nil {
		t.Fatal("expected cache_control on system block")
	}
	if block.CacheControl.Type != "ephemeral" {
		t.Errorf("expected cache_control type 'ephemeral', got %q", block.CacheControl.Type)
	}
}

func TestBuildRequest_SystemPromptCachingDisabled(t *testing.T) {
	c := NewAnthropicClient("http://localhost", "sk-test", WithPromptCaching(false))

	messages := []Message{
		{Role: RoleSystem, Content: "You are a helpful assistant."},
		{Role: RoleUser, Content: "Hello"},
	}

	req := c.buildRequest(messages, nil)

	if len(req.System) != 1 {
		t.Fatalf("expected 1 system block, got %d", len(req.System))
	}
	if req.System[0].CacheControl != nil {
		t.Error("expected no cache_control when caching is disabled")
	}
}

func TestBuildRequest_LastToolGetsCacheControl(t *testing.T) {
	c := NewAnthropicClient("http://localhost", "sk-test")

	tools := []ToolDefinition{
		{Name: "read_file", Description: "Read a file", Parameters: map[string]any{"type": "object"}},
		{Name: "write_file", Description: "Write a file", Parameters: map[string]any{"type": "object"}},
		{Name: "list_dir", Description: "List directory", Parameters: map[string]any{"type": "object"}},
	}

	messages := []Message{{Role: RoleUser, Content: "Hello"}}
	req := c.buildRequest(messages, tools)

	if len(req.Tools) != 3 {
		t.Fatalf("expected 3 tools, got %d", len(req.Tools))
	}

	// First and second tools should NOT have cache_control.
	for i := 0; i < 2; i++ {
		if req.Tools[i].CacheControl != nil {
			t.Errorf("tool[%d] should not have cache_control", i)
		}
	}

	// Last tool should have cache_control.
	last := req.Tools[2]
	if last.CacheControl == nil {
		t.Fatal("expected cache_control on last tool")
	}
	if last.CacheControl.Type != "ephemeral" {
		t.Errorf("expected cache_control type 'ephemeral', got %q", last.CacheControl.Type)
	}
}

func TestBuildRequest_ToolsCachingDisabled(t *testing.T) {
	c := NewAnthropicClient("http://localhost", "sk-test", WithPromptCaching(false))

	tools := []ToolDefinition{
		{Name: "read_file", Description: "Read a file", Parameters: map[string]any{"type": "object"}},
	}

	messages := []Message{{Role: RoleUser, Content: "Hello"}}
	req := c.buildRequest(messages, tools)

	if req.Tools[0].CacheControl != nil {
		t.Error("expected no cache_control on tool when caching is disabled")
	}
}

func TestParseResponse_CacheUsageFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]any{
			"id":   "msg_123",
			"type": "message",
			"role": "assistant",
			"content": []map[string]any{
				{"type": "text", "text": "Hello!"},
			},
			"stop_reason": "end_turn",
			"usage": map[string]any{
				"input_tokens":                10,
				"output_tokens":               5,
				"cache_creation_input_tokens": 1500,
				"cache_read_input_tokens":     3000,
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	c := NewAnthropicClient(server.URL, "sk-test")
	resp, err := c.SendMessage(context.Background(), []Message{
		{Role: RoleUser, Content: "Hi"},
	}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if resp.CacheCreationInputTokens != 1500 {
		t.Errorf("expected CacheCreationInputTokens=1500, got %d", resp.CacheCreationInputTokens)
	}
	if resp.CacheReadInputTokens != 3000 {
		t.Errorf("expected CacheReadInputTokens=3000, got %d", resp.CacheReadInputTokens)
	}
}

func TestBuildRequest_SystemSerializedAsArrayOfBlocks(t *testing.T) {
	c := NewAnthropicClient("http://localhost", "sk-test")

	messages := []Message{
		{Role: RoleSystem, Content: "System prompt here."},
		{Role: RoleUser, Content: "Hello"},
	}

	req := c.buildRequest(messages, nil)

	// Marshal the request and verify system is an array, not a string.
	data, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}

	systemJSON := raw["system"]
	// Must start with '[' (array), not '"' (string).
	if len(systemJSON) == 0 || systemJSON[0] != '[' {
		t.Errorf("expected system to be JSON array, got: %s", string(systemJSON))
	}
}

func TestSendMessage_RequestFormat(t *testing.T) {
	// Verify the full wire format sent to the API.
	var capturedBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedBody, _ = io.ReadAll(r.Body)
		resp := map[string]any{
			"id":          "msg_123",
			"type":        "message",
			"role":        "assistant",
			"content":     []map[string]any{{"type": "text", "text": "Hi"}},
			"stop_reason": "end_turn",
			"usage":       map[string]any{"input_tokens": 10, "output_tokens": 5},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	c := NewAnthropicClient(server.URL, "sk-test")
	tools := []ToolDefinition{
		{Name: "tool_a", Description: "A", Parameters: map[string]any{"type": "object"}},
		{Name: "tool_b", Description: "B", Parameters: map[string]any{"type": "object"}},
	}

	_, err := c.SendMessage(context.Background(), []Message{
		{Role: RoleSystem, Content: "Be helpful."},
		{Role: RoleUser, Content: "Hi"},
	}, tools)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var reqBody map[string]json.RawMessage
	if err := json.Unmarshal(capturedBody, &reqBody); err != nil {
		t.Fatalf("unmarshal captured body: %v", err)
	}

	// Verify system is array with cache_control.
	var system []map[string]any
	if err := json.Unmarshal(reqBody["system"], &system); err != nil {
		t.Fatalf("unmarshal system: %v", err)
	}
	if len(system) != 1 {
		t.Fatalf("expected 1 system block, got %d", len(system))
	}
	cc, ok := system[0]["cache_control"].(map[string]any)
	if !ok {
		t.Fatal("expected cache_control in system block")
	}
	if cc["type"] != "ephemeral" {
		t.Errorf("expected ephemeral cache_control, got %v", cc["type"])
	}

	// Verify last tool has cache_control.
	var toolsArr []map[string]any
	if err := json.Unmarshal(reqBody["tools"], &toolsArr); err != nil {
		t.Fatalf("unmarshal tools: %v", err)
	}
	if len(toolsArr) != 2 {
		t.Fatalf("expected 2 tools, got %d", len(toolsArr))
	}
	if toolsArr[0]["cache_control"] != nil {
		t.Error("first tool should not have cache_control")
	}
	lastCC, ok := toolsArr[1]["cache_control"].(map[string]any)
	if !ok {
		t.Fatal("expected cache_control on last tool")
	}
	if lastCC["type"] != "ephemeral" {
		t.Errorf("expected ephemeral, got %v", lastCC["type"])
	}
}
