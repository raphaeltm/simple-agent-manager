package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// SendMessageStream implements StreamProvider for the Anthropic Messages API.
func (c *AnthropicClient) SendMessageStream(ctx context.Context, messages []Message, tools []ToolDefinition) (<-chan StreamEvent, error) {
	reqBody := c.buildRequest(messages, tools)

	// Anthropic streaming uses "stream": true in the request body.
	type streamReq struct {
		anthRequest
		Stream bool `json:"stream"`
	}
	sr := streamReq{anthRequest: reqBody, Stream: true}

	jsonBody, err := json.Marshal(sr)
	if err != nil {
		return nil, fmt.Errorf("anthropic: marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/v1/messages", bytes.NewReader(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("anthropic: create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("anthropic-version", "2023-06-01")

	// Set auth header.
	authH := c.authHeader
	if authH == "" {
		if strings.HasPrefix(c.apiKey, "sk-ant-oat") {
			authH = "Authorization"
		} else {
			authH = "x-api-key"
		}
	}
	if authH == "Authorization" || authH == "cf-aig-authorization" {
		req.Header.Set(authH, "Bearer "+c.apiKey)
	} else {
		req.Header.Set(authH, c.apiKey)
	}

	// Use a client without timeout for streaming.
	streamClient := &http.Client{}
	resp, err := streamClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("anthropic: http request: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		buf := make([]byte, 4096)
		n, _ := resp.Body.Read(buf)
		return nil, c.parseError(resp.StatusCode, buf[:n])
	}

	ch := make(chan StreamEvent, 16)

	go func() {
		defer close(ch)
		defer resp.Body.Close()

		var (
			currentToolIndex int
			toolIndex        = -1 // tracks which tool_use block we're in
			usage            *Usage
		)

		err := parseAnthropicSSE(ctx, resp.Body, func(eventType, data string) bool {
			switch eventType {
			case "content_block_start":
				var block struct {
					Index        int `json:"index"`
					ContentBlock struct {
						Type  string          `json:"type"`
						ID    string          `json:"id,omitempty"`
						Name  string          `json:"name,omitempty"`
						Text  string          `json:"text,omitempty"`
						Input json.RawMessage `json:"input,omitempty"`
					} `json:"content_block"`
				}
				if json.Unmarshal([]byte(data), &block) != nil {
					return true
				}
				if block.ContentBlock.Type == "tool_use" {
					toolIndex++
					currentToolIndex = toolIndex
					ch <- StreamEvent{
						Type: EventToolCallStart,
						ToolCall: &ToolCallDelta{
							Index: currentToolIndex,
							ID:    block.ContentBlock.ID,
							Name:  block.ContentBlock.Name,
						},
					}
				}

			case "content_block_delta":
				var delta struct {
					Index int `json:"index"`
					Delta struct {
						Type        string `json:"type"`
						Text        string `json:"text,omitempty"`
						PartialJSON string `json:"partial_json,omitempty"`
					} `json:"delta"`
				}
				if json.Unmarshal([]byte(data), &delta) != nil {
					return true
				}
				switch delta.Delta.Type {
				case "text_delta":
					if delta.Delta.Text != "" {
						ch <- StreamEvent{
							Type:  EventContentDelta,
							Delta: delta.Delta.Text,
						}
					}
				case "input_json_delta":
					if delta.Delta.PartialJSON != "" {
						ch <- StreamEvent{
							Type: EventToolCallDelta,
							ToolCall: &ToolCallDelta{
								Index:          currentToolIndex,
								ArgumentsDelta: delta.Delta.PartialJSON,
							},
						}
					}
				}

			case "message_delta":
				var md struct {
					Delta struct {
						StopReason string `json:"stop_reason"`
					} `json:"delta"`
					Usage *struct {
						OutputTokens int `json:"output_tokens"`
					} `json:"usage,omitempty"`
				}
				if json.Unmarshal([]byte(data), &md) == nil {
					if md.Usage != nil && usage != nil {
						usage.CompletionTokens = md.Usage.OutputTokens
						usage.TotalTokens = usage.PromptTokens + usage.CompletionTokens
					}
				}

			case "message_start":
				var ms struct {
					Message struct {
						Usage *struct {
							InputTokens              int `json:"input_tokens"`
							OutputTokens             int `json:"output_tokens"`
							CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
							CacheReadInputTokens     int `json:"cache_read_input_tokens"`
						} `json:"usage,omitempty"`
					} `json:"message"`
				}
				if json.Unmarshal([]byte(data), &ms) == nil && ms.Message.Usage != nil {
					usage = &Usage{
						PromptTokens:             ms.Message.Usage.InputTokens,
						CompletionTokens:         ms.Message.Usage.OutputTokens,
						TotalTokens:              ms.Message.Usage.InputTokens + ms.Message.Usage.OutputTokens,
						CacheCreationInputTokens: ms.Message.Usage.CacheCreationInputTokens,
						CacheReadInputTokens:     ms.Message.Usage.CacheReadInputTokens,
					}
				}

			case "message_stop":
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

// parseAnthropicSSE parses Anthropic's SSE format which uses "event:" lines
// followed by "data:" lines (different from OpenAI's data-only format).
func parseAnthropicSSE(ctx context.Context, r interface{ Read([]byte) (int, error) }, handler func(eventType, data string) bool) error {
	scanner := newLineScanner(r)
	var currentEvent string

	for scanner.Scan() {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		line := scanner.Text()

		if strings.HasPrefix(line, "event: ") {
			currentEvent = strings.TrimPrefix(line, "event: ")
			continue
		}

		if strings.HasPrefix(line, "data: ") {
			data := strings.TrimPrefix(line, "data: ")
			if currentEvent != "" {
				if !handler(currentEvent, data) {
					return nil
				}
				currentEvent = ""
			}
			continue
		}
	}

	return scanner.Err()
}
