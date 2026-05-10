package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// AnthropicClient implements Provider using the Anthropic Messages API.
type AnthropicClient struct {
	baseURL        string
	apiKey         string
	model          string
	authHeader     string // header name for the API key (default: "x-api-key")
	promptCaching  bool   // whether to add cache_control blocks
	httpClient     *http.Client
}

// AnthropicOption configures an AnthropicClient.
type AnthropicOption func(*AnthropicClient)

// WithAnthropicModel sets the model ID.
func WithAnthropicModel(model string) AnthropicOption {
	return func(c *AnthropicClient) { c.model = model }
}

// WithAnthropicAuthHeader sets a custom authorization header name.
func WithAnthropicAuthHeader(header string) AnthropicOption {
	return func(c *AnthropicClient) { c.authHeader = header }
}

// WithPromptCaching enables or disables cache_control blocks on system prompts and tools.
// Defaults to true. Prompt caching gives ~90% cost savings on repeated system prompts.
func WithPromptCaching(enabled bool) AnthropicOption {
	return func(c *AnthropicClient) { c.promptCaching = enabled }
}

// NewAnthropicClient creates a new Anthropic Messages API provider.
// baseURL should be the API base (e.g. "https://api.anthropic.com" or a gateway URL).
func NewAnthropicClient(baseURL, apiKey string, opts ...AnthropicOption) *AnthropicClient {
	c := &AnthropicClient{
		baseURL:       strings.TrimRight(baseURL, "/"),
		apiKey:        apiKey,
		model:         "claude-sonnet-4-5-20250514",
		promptCaching: true,
		httpClient: &http.Client{
			Timeout: 120 * time.Second,
		},
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// SendMessage implements Provider using the Anthropic Messages API.
func (c *AnthropicClient) SendMessage(ctx context.Context, messages []Message, tools []ToolDefinition) (*Response, error) {
	reqBody := c.buildRequest(messages, tools)

	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("anthropic: marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/v1/messages", bytes.NewReader(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("anthropic: create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("anthropic-version", "2023-06-01")

	// Set auth header.
	authH := c.authHeader
	if authH == "" {
		// Auto-detect: OAuth tokens (sk-ant-oat*) use Authorization: Bearer;
		// API keys (sk-ant-api*) use x-api-key.
		if strings.HasPrefix(c.apiKey, "sk-ant-oat") {
			authH = "Authorization"
		} else {
			authH = "x-api-key"
		}
	}

	// Headers that use Bearer format.
	if authH == "Authorization" || authH == "cf-aig-authorization" {
		req.Header.Set(authH, "Bearer "+c.apiKey)
	} else {
		req.Header.Set(authH, c.apiKey)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("anthropic: http request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("anthropic: read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, c.parseError(resp.StatusCode, body)
	}

	return c.parseResponse(body)
}

func (c *AnthropicClient) buildRequest(messages []Message, tools []ToolDefinition) anthRequest {
	// Separate system messages from conversation messages.
	var systemText string
	var convMessages []Message
	for _, m := range messages {
		if m.Role == RoleSystem {
			if systemText != "" {
				systemText += "\n\n"
			}
			systemText += m.Content
		} else {
			convMessages = append(convMessages, m)
		}
	}

	// Convert messages to Anthropic format.
	// Anthropic requires strict user/assistant alternation.
	// Tool results must be sent as user messages with tool_result content blocks.
	anthMsgs := make([]anthMessage, 0, len(convMessages))

	for _, m := range convMessages {
		switch m.Role {
		case RoleUser:
			anthMsgs = append(anthMsgs, anthMessage{
				Role:    "user",
				Content: []anthContentBlock{{Type: "text", Text: m.Content}},
			})
		case RoleAssistant:
			var blocks []anthContentBlock
			if m.Content != "" {
				blocks = append(blocks, anthContentBlock{Type: "text", Text: m.Content})
			}
			for _, tc := range m.ToolCalls {
				input := tc.Params
				if input == nil {
					input = map[string]any{}
				}
				inputJSON, _ := json.Marshal(input)
				blocks = append(blocks, anthContentBlock{
					Type:  "tool_use",
					ID:    tc.ID,
					Name:  tc.Name,
					Input: inputJSON,
				})
			}
			anthMsgs = append(anthMsgs, anthMessage{
				Role:    "assistant",
				Content: blocks,
			})
		case RoleTool:
			if m.ToolResult != nil {
				block := anthContentBlock{
					Type:      "tool_result",
					ToolUseID: m.ToolResult.CallID,
					Content:   m.ToolResult.Content,
				}
				if m.ToolResult.IsError {
					block.IsError = true
				}
				// Try to merge with previous user message (Anthropic wants tool_result in user messages).
				if len(anthMsgs) > 0 && anthMsgs[len(anthMsgs)-1].Role == "user" {
					anthMsgs[len(anthMsgs)-1].Content = append(anthMsgs[len(anthMsgs)-1].Content, block)
				} else {
					anthMsgs = append(anthMsgs, anthMessage{
						Role:    "user",
						Content: []anthContentBlock{block},
					})
				}
			}
		}
	}

	req := anthRequest{
		Model:     c.model,
		MaxTokens: 4096,
		Messages:  anthMsgs,
	}
	if systemText != "" {
		block := anthSystemBlock{Type: "text", Text: systemText}
		if c.promptCaching {
			block.CacheControl = &anthCacheControl{Type: "ephemeral"}
		}
		req.System = []anthSystemBlock{block}
	}

	if len(tools) > 0 {
		anthTools := make([]anthTool, len(tools))
		for i, t := range tools {
			anthTools[i] = anthTool{
				Name:        t.Name,
				Description: t.Description,
				InputSchema: t.Parameters,
			}
		}
		if c.promptCaching {
			anthTools[len(anthTools)-1].CacheControl = &anthCacheControl{Type: "ephemeral"}
		}
		req.Tools = anthTools
	}

	return req
}

func (c *AnthropicClient) parseResponse(body []byte) (*Response, error) {
	var anthResp anthResponse
	if err := json.Unmarshal(body, &anthResp); err != nil {
		return nil, fmt.Errorf("anthropic: parse response: %w", err)
	}

	resp := &Response{
		StopReason: anthResp.StopReason,
	}
	if anthResp.Usage != nil {
		resp.Usage = &Usage{
			PromptTokens:             anthResp.Usage.InputTokens,
			CompletionTokens:         anthResp.Usage.OutputTokens,
			TotalTokens:              anthResp.Usage.InputTokens + anthResp.Usage.OutputTokens,
			CacheCreationInputTokens: anthResp.Usage.CacheCreationInputTokens,
			CacheReadInputTokens:     anthResp.Usage.CacheReadInputTokens,
		}
	}

	for _, block := range anthResp.Content {
		switch block.Type {
		case "text":
			if resp.Content != "" {
				resp.Content += "\n"
			}
			resp.Content += block.Text
		case "tool_use":
			var params map[string]any
			if len(block.Input) > 0 {
				_ = json.Unmarshal(block.Input, &params)
			}
			if params == nil {
				params = map[string]any{}
			}
			resp.ToolCalls = append(resp.ToolCalls, ToolCall{
				ID:     block.ID,
				Name:   block.Name,
				Params: params,
			})
		}
	}

	if len(resp.ToolCalls) > 0 {
		resp.StopReason = "tool_use"
	}

	return resp, nil
}

func (c *AnthropicClient) parseError(statusCode int, body []byte) error {
	var errResp struct {
		Error struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &errResp) == nil && errResp.Error.Message != "" {
		return fmt.Errorf("anthropic: API error (HTTP %d, type=%s): %s",
			statusCode, errResp.Error.Type, errResp.Error.Message)
	}
	raw := string(body)
	if len(raw) > 200 {
		raw = raw[:200] + "..."
	}
	return fmt.Errorf("anthropic: HTTP %d: %s", statusCode, raw)
}

// --- Anthropic API wire types ---

type anthCacheControl struct {
	Type string `json:"type"`
}

type anthSystemBlock struct {
	Type         string            `json:"type"`
	Text         string            `json:"text"`
	CacheControl *anthCacheControl `json:"cache_control,omitempty"`
}

type anthRequest struct {
	Model     string           `json:"model"`
	MaxTokens int              `json:"max_tokens"`
	System    []anthSystemBlock `json:"system,omitempty"`
	Messages  []anthMessage    `json:"messages"`
	Tools     []anthTool       `json:"tools,omitempty"`
}

type anthMessage struct {
	Role    string             `json:"role"`
	Content []anthContentBlock `json:"content"`
}

// anthContentBlock is a union type for Anthropic message content.
// We use json.RawMessage for Input to control serialization:
// tool_use blocks MUST include "input" (even if empty {}),
// while text/tool_result blocks must NOT include it.
type anthContentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
	Content   string          `json:"content,omitempty"`
	IsError   bool            `json:"is_error,omitempty"`
}

type anthTool struct {
	Name         string            `json:"name"`
	Description  string            `json:"description"`
	InputSchema  map[string]any    `json:"input_schema"`
	CacheControl *anthCacheControl `json:"cache_control,omitempty"`
}

type anthResponse struct {
	ID         string             `json:"id"`
	Type       string             `json:"type"`
	Role       string             `json:"role"`
	Content    []anthContentBlock `json:"content"`
	StopReason string             `json:"stop_reason"`
	Usage      *struct {
		InputTokens              int `json:"input_tokens"`
		OutputTokens             int `json:"output_tokens"`
		CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
		CacheReadInputTokens     int `json:"cache_read_input_tokens"`
	} `json:"usage,omitempty"`
}
