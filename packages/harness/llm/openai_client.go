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

// DefaultModel is the default Workers AI model for the harness.
const DefaultModel = "@cf/google/gemma-4-26b-a4b-it"

// OpenAIClient implements Provider using an OpenAI-compatible chat completions API.
// It supports Workers AI models via SAM's AI proxy / Cloudflare AI Gateway.
type OpenAIClient struct {
	baseURL    string
	apiKey     string
	model      string
	authHeader string // custom auth header name (default: "Authorization")
	httpClient *http.Client
}

// OpenAIOption configures an OpenAIClient.
type OpenAIOption func(*OpenAIClient)

// WithModel sets the model ID for completions.
func WithModel(model string) OpenAIOption {
	return func(c *OpenAIClient) { c.model = model }
}

// WithAuthHeader sets a custom auth header name (e.g. "cf-aig-authorization" for
// Cloudflare AI Gateway unified billing). The value is still "Bearer <key>".
func WithAuthHeader(header string) OpenAIOption {
	return func(c *OpenAIClient) { c.authHeader = header }
}

// WithHTTPClient sets a custom HTTP client (useful for testing).
func WithHTTPClient(client *http.Client) OpenAIOption {
	return func(c *OpenAIClient) { c.httpClient = client }
}

// NewOpenAIClient creates a new OpenAI-compatible provider.
// baseURL should be the API base (e.g. "https://api.sammy.party/api/ai/proxy/openai/v1").
// apiKey is the Bearer token for Authorization.
func NewOpenAIClient(baseURL, apiKey string, opts ...OpenAIOption) *OpenAIClient {
	c := &OpenAIClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		model:   DefaultModel,
		httpClient: &http.Client{
			Timeout: 120 * time.Second,
		},
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// SendMessage implements Provider. It sends the conversation to the OpenAI-compatible
// chat completions endpoint and returns the parsed response.
func (c *OpenAIClient) SendMessage(ctx context.Context, messages []Message, tools []ToolDefinition) (*Response, error) {
	reqBody := c.buildRequest(messages, tools)

	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("openai: marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("openai: create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	authHdr := c.authHeader
	if authHdr == "" {
		authHdr = "Authorization"
	}
	req.Header.Set(authHdr, "Bearer "+c.apiKey)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("openai: http request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("openai: read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, c.parseError(resp.StatusCode, body)
	}

	return c.parseResponse(body)
}

// buildRequest constructs the OpenAI-compatible request body, applying
// model-specific workarounds for Workers AI quirks.
func (c *OpenAIClient) buildRequest(messages []Message, tools []ToolDefinition) oaiRequest {
	oaiMessages := make([]oaiMessage, 0, len(messages))
	for _, m := range messages {
		oaiMsg := oaiMessage{Role: string(m.Role)}

		// Handle content normalization.
		// Qwen models require content: "" instead of null for assistant messages with tool_calls.
		// Gemma 4 handles content: null fine.
		if m.Content == "" && m.Role == RoleAssistant && len(m.ToolCalls) > 0 && c.isQwenModel() {
			empty := ""
			oaiMsg.Content = &empty
		} else if m.Content != "" {
			oaiMsg.Content = &m.Content
		}

		// Convert tool calls.
		if len(m.ToolCalls) > 0 {
			calls := make([]oaiToolCall, len(m.ToolCalls))
			for i, tc := range m.ToolCalls {
				args, _ := json.Marshal(tc.Params)
				calls[i] = oaiToolCall{
					ID:   tc.ID,
					Type: "function",
					Function: oaiFunction{
						Name:      tc.Name,
						Arguments: string(args),
					},
				}
			}
			oaiMsg.ToolCalls = calls
		}

		// Convert tool results.
		if m.ToolResult != nil {
			oaiMsg.ToolCallID = m.ToolResult.CallID
			content := m.ToolResult.Content
			oaiMsg.Content = &content
		}

		oaiMessages = append(oaiMessages, oaiMsg)
	}

	req := oaiRequest{
		Model:    c.model,
		Messages: oaiMessages,
	}

	if len(tools) > 0 {
		oaiTools := make([]oaiTool, len(tools))
		for i, t := range tools {
			oaiTools[i] = oaiTool{
				Type: "function",
				Function: oaiToolDef{
					Name:        t.Name,
					Description: t.Description,
					Parameters:  t.Parameters,
				},
			}
		}
		req.Tools = oaiTools

		// Qwen models need tool_choice: "required" because "auto" produces text
		// instead of structured tool calls. Gemma 4 works with "auto".
		if c.isQwenModel() {
			req.ToolChoice = "required"
		} else {
			req.ToolChoice = "auto"
		}
	}

	return req
}

// parseResponse converts the OpenAI-format response to our Response type.
func (c *OpenAIClient) parseResponse(body []byte) (*Response, error) {
	var oaiResp oaiResponse
	if err := json.Unmarshal(body, &oaiResp); err != nil {
		return nil, fmt.Errorf("openai: parse response: %w", err)
	}

	if len(oaiResp.Choices) == 0 {
		return nil, fmt.Errorf("openai: response has no choices")
	}

	choice := oaiResp.Choices[0]
	resp := &Response{
		StopReason: choice.FinishReason,
	}

	// Extract content — prefer reasoning content for logging if present (Gemma 4).
	if choice.Message.Content != nil {
		resp.Content = *choice.Message.Content
	}

	// Capture usage.
	if oaiResp.Usage != nil {
		resp.Usage = &Usage{
			PromptTokens:     oaiResp.Usage.PromptTokens,
			CompletionTokens: oaiResp.Usage.CompletionTokens,
			TotalTokens:      oaiResp.Usage.TotalTokens,
		}
		if oaiResp.Usage.CompletionDetails != nil {
			resp.Usage.ReasoningTokens = oaiResp.Usage.CompletionDetails.ReasoningTokens
		}
	}

	// Convert tool calls.
	if len(choice.Message.ToolCalls) > 0 {
		resp.ToolCalls = make([]ToolCall, len(choice.Message.ToolCalls))
		for i, tc := range choice.Message.ToolCalls {
			var params map[string]any
			if err := json.Unmarshal([]byte(tc.Function.Arguments), &params); err != nil {
				// If arguments aren't valid JSON, wrap as raw string.
				params = map[string]any{"_raw": tc.Function.Arguments}
			}
			resp.ToolCalls[i] = ToolCall{
				ID:     tc.ID,
				Name:   tc.Function.Name,
				Params: params,
			}
		}
		resp.StopReason = "tool_use"
	}

	return resp, nil
}

// parseError constructs an error from a non-200 response.
func (c *OpenAIClient) parseError(statusCode int, body []byte) error {
	var errResp struct {
		Error struct {
			Message string `json:"message"`
			Type    string `json:"type"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &errResp) == nil && errResp.Error.Message != "" {
		return fmt.Errorf("openai: API error (HTTP %d, type=%s): %s",
			statusCode, errResp.Error.Type, errResp.Error.Message)
	}
	// Truncate raw body for the error message.
	raw := string(body)
	if len(raw) > 200 {
		raw = raw[:200] + "..."
	}
	return fmt.Errorf("openai: HTTP %d: %s", statusCode, raw)
}

// isQwenModel returns true if the configured model is a Qwen variant.
func (c *OpenAIClient) isQwenModel() bool {
	return strings.Contains(strings.ToLower(c.model), "qwen")
}

// --- OpenAI API wire types ---

type oaiRequest struct {
	Model      string       `json:"model"`
	Messages   []oaiMessage `json:"messages"`
	Tools      []oaiTool    `json:"tools,omitempty"`
	ToolChoice string       `json:"tool_choice,omitempty"`
	Stream     bool         `json:"stream"`
}

type oaiMessage struct {
	Role       string        `json:"role"`
	Content    *string       `json:"content"` // pointer to distinguish null from ""
	ToolCalls  []oaiToolCall `json:"tool_calls,omitempty"`
	ToolCallID string        `json:"tool_call_id,omitempty"`
}

type oaiToolCall struct {
	ID       string      `json:"id"`
	Type     string      `json:"type"`
	Function oaiFunction `json:"function"`
}

type oaiFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type oaiTool struct {
	Type     string     `json:"type"`
	Function oaiToolDef `json:"function"`
}

type oaiToolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

type oaiResponse struct {
	ID      string `json:"id"`
	Choices []struct {
		Index        int  `json:"index"`
		FinishReason string `json:"finish_reason"`
		Message      struct {
			Role      string        `json:"role"`
			Content   *string       `json:"content"`
			ToolCalls []oaiToolCall `json:"tool_calls,omitempty"`
		} `json:"message"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
		CompletionDetails *struct {
			ReasoningTokens int `json:"reasoning_tokens"`
		} `json:"completion_tokens_details,omitempty"`
	} `json:"usage,omitempty"`
}
