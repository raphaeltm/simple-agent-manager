package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// SendMessageStream implements StreamProvider for OpenAI-compatible APIs.
func (c *OpenAIClient) SendMessageStream(ctx context.Context, messages []Message, tools []ToolDefinition) (<-chan StreamEvent, error) {
	reqBody := c.buildRequest(messages, tools)
	reqBody.Stream = true

	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("openai: marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("openai: create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	authH := c.authHeader
	if authH == "" {
		authH = "Authorization"
	}
	req.Header.Set(authH, "Bearer "+c.apiKey)

	// Use a client without timeout for streaming (context handles cancellation).
	streamClient := &http.Client{}
	resp, err := streamClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("openai: http request: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		buf := make([]byte, 1024)
		n, _ := resp.Body.Read(buf)
		return nil, c.parseError(resp.StatusCode, buf[:n])
	}

	ch := make(chan StreamEvent, 16)

	go func() {
		defer close(ch)
		defer resp.Body.Close()

		err := parseSSELines(ctx, resp.Body, func(data string) bool {
			var chunk oaiStreamChunk
			if err := json.Unmarshal([]byte(data), &chunk); err != nil {
				ch <- StreamEvent{Type: EventError, Error: fmt.Errorf("openai: parse chunk: %w", err)}
				return false
			}

			if len(chunk.Choices) == 0 {
				// Usage-only chunk (some providers send this at the end).
				if chunk.Usage != nil {
					ch <- StreamEvent{
						Type: EventDone,
						Usage: &Usage{
							PromptTokens:     chunk.Usage.PromptTokens,
							CompletionTokens: chunk.Usage.CompletionTokens,
							TotalTokens:      chunk.Usage.TotalTokens,
						},
					}
					return false
				}
				return true
			}

			choice := chunk.Choices[0]

			// Content delta.
			if choice.Delta.Content != nil && *choice.Delta.Content != "" {
				ch <- StreamEvent{
					Type:  EventContentDelta,
					Delta: *choice.Delta.Content,
				}
			}

			// Tool call deltas.
			for _, tc := range choice.Delta.ToolCalls {
				if tc.ID != "" {
					// New tool call starting.
					ch <- StreamEvent{
						Type: EventToolCallStart,
						ToolCall: &ToolCallDelta{
							Index: tc.Index,
							ID:    tc.ID,
							Name:  tc.Function.Name,
						},
					}
				}
				if tc.Function.Arguments != "" {
					ch <- StreamEvent{
						Type: EventToolCallDelta,
						ToolCall: &ToolCallDelta{
							Index:          tc.Index,
							ArgumentsDelta: tc.Function.Arguments,
						},
					}
				}
			}

			// Check for finish.
			if choice.FinishReason != "" {
				var usage *Usage
				if chunk.Usage != nil {
					usage = &Usage{
						PromptTokens:     chunk.Usage.PromptTokens,
						CompletionTokens: chunk.Usage.CompletionTokens,
						TotalTokens:      chunk.Usage.TotalTokens,
					}
				}
				ch <- StreamEvent{Type: EventDone, Usage: usage}
				return false
			}

			return true
		})

		if err != nil {
			ch <- StreamEvent{Type: EventError, Error: err}
		}
	}()

	return ch, nil
}

// --- OpenAI streaming wire types ---

type oaiStreamChunk struct {
	ID      string `json:"id"`
	Choices []struct {
		Index        int    `json:"index"`
		FinishReason string `json:"finish_reason"`
		Delta        struct {
			Role      string              `json:"role,omitempty"`
			Content   *string             `json:"content,omitempty"`
			ToolCalls []oaiStreamToolCall `json:"tool_calls,omitempty"`
		} `json:"delta"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
	} `json:"usage,omitempty"`
}

type oaiStreamToolCall struct {
	Index    int         `json:"index"`
	ID       string      `json:"id,omitempty"`
	Type     string      `json:"type,omitempty"`
	Function oaiFunction `json:"function"`
}
