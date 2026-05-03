package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const defaultProxyTimeout = 2 * time.Minute

// OpenAIProxyConfig configures an OpenAI-compatible chat completions provider.
type OpenAIProxyConfig struct {
	BaseURL    string
	APIKey     string
	Model      string
	ToolChoice string
	HTTPClient *http.Client
}

// OpenAIProxyProvider calls an OpenAI-compatible chat completions endpoint.
type OpenAIProxyProvider struct {
	baseURL    string
	apiKey     string
	model      string
	toolChoice string
	client     *http.Client
}

// NewOpenAIProxyProvider creates a provider for SAM's OpenAI-compatible AI proxy
// or any compatible endpoint.
func NewOpenAIProxyProvider(cfg OpenAIProxyConfig) (*OpenAIProxyProvider, error) {
	if strings.TrimSpace(cfg.BaseURL) == "" {
		return nil, errors.New("base URL is required")
	}
	if strings.TrimSpace(cfg.APIKey) == "" {
		return nil, errors.New("API key is required")
	}
	if strings.TrimSpace(cfg.Model) == "" {
		return nil, errors.New("model is required")
	}

	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: defaultProxyTimeout}
	}

	return &OpenAIProxyProvider{
		baseURL:    strings.TrimRight(cfg.BaseURL, "/"),
		apiKey:     cfg.APIKey,
		model:      cfg.Model,
		toolChoice: cfg.ToolChoice,
		client:     client,
	}, nil
}

// SendMessage sends a chat-completions request and maps the response back into
// the harness-native LLM types.
func (p *OpenAIProxyProvider) SendMessage(ctx context.Context, messages []Message, tools []ToolDefinition) (*Response, error) {
	body := openAIChatRequest{
		Model:    p.model,
		Messages: toOpenAIMessages(messages),
	}
	if len(tools) > 0 {
		body.Tools = toOpenAITools(tools)
		if p.toolChoice != "" {
			body.ToolChoice = p.toolChoice
		}
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+p.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("send request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("proxy returned %d: %s", resp.StatusCode, truncateErrorBody(respBody))
	}

	var parsed openAIChatResponse
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	if len(parsed.Choices) == 0 {
		return nil, errors.New("response had no choices")
	}

	msg := parsed.Choices[0].Message
	toolCalls, err := fromOpenAIToolCalls(msg.ToolCalls)
	if err != nil {
		return nil, err
	}

	return &Response{
		Content:    msg.Content,
		ToolCalls:  toolCalls,
		StopReason: parsed.Choices[0].FinishReason,
	}, nil
}

type openAIChatRequest struct {
	Model      string          `json:"model"`
	Messages   []openAIMessage `json:"messages"`
	Tools      []openAITool    `json:"tools,omitempty"`
	ToolChoice string          `json:"tool_choice,omitempty"`
}

type openAIMessage struct {
	Role       string           `json:"role"`
	Content    string           `json:"content"`
	ToolCallID string           `json:"tool_call_id,omitempty"`
	ToolCalls  []openAIToolCall `json:"tool_calls,omitempty"`
}

type openAITool struct {
	Type     string         `json:"type"`
	Function openAIFunction `json:"function"`
}

type openAIFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters"`
	Arguments   string         `json:"arguments,omitempty"`
}

type openAIToolCall struct {
	ID       string         `json:"id"`
	Type     string         `json:"type"`
	Function openAIFunction `json:"function"`
}

type openAIChatResponse struct {
	Choices []openAIChoice `json:"choices"`
}

type openAIChoice struct {
	Message      openAIMessage `json:"message"`
	FinishReason string        `json:"finish_reason"`
}

func toOpenAIMessages(messages []Message) []openAIMessage {
	out := make([]openAIMessage, 0, len(messages))
	for _, msg := range messages {
		if msg.Role == RoleTool && msg.ToolResult != nil {
			out = append(out, openAIMessage{
				Role:       string(RoleTool),
				Content:    msg.ToolResult.Content,
				ToolCallID: msg.ToolResult.CallID,
			})
			continue
		}

		out = append(out, openAIMessage{
			Role:      string(msg.Role),
			Content:   msg.Content,
			ToolCalls: toOpenAIToolCalls(msg.ToolCalls),
		})
	}
	return out
}

func toOpenAITools(tools []ToolDefinition) []openAITool {
	out := make([]openAITool, 0, len(tools))
	for _, tool := range tools {
		out = append(out, openAITool{
			Type: "function",
			Function: openAIFunction{
				Name:        tool.Name,
				Description: tool.Description,
				Parameters:  tool.Parameters,
			},
		})
	}
	return out
}

func toOpenAIToolCalls(calls []ToolCall) []openAIToolCall {
	out := make([]openAIToolCall, 0, len(calls))
	for _, call := range calls {
		args, err := json.Marshal(call.Params)
		if err != nil {
			args = []byte("{}")
		}
		out = append(out, openAIToolCall{
			ID:   call.ID,
			Type: "function",
			Function: openAIFunction{
				Name:      call.Name,
				Arguments: string(args),
			},
		})
	}
	return out
}

func fromOpenAIToolCalls(calls []openAIToolCall) ([]ToolCall, error) {
	out := make([]ToolCall, 0, len(calls))
	for _, call := range calls {
		params := map[string]any{}
		if strings.TrimSpace(call.Function.Arguments) != "" {
			if err := json.Unmarshal([]byte(call.Function.Arguments), &params); err != nil {
				return nil, fmt.Errorf("decode tool call %s arguments: %w", call.ID, err)
			}
		}
		out = append(out, ToolCall{
			ID:     call.ID,
			Name:   call.Function.Name,
			Params: params,
		})
	}
	return out, nil
}

func truncateErrorBody(body []byte) string {
	const max = 1000
	if len(body) <= max {
		return string(body)
	}
	return string(body[:max]) + "...(truncated)"
}
