// Package mcp provides a Go client for the MCP (Model Context Protocol) server,
// enabling the harness to call SAM platform tools over HTTP+SSE.
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
)

// Client communicates with an MCP server over HTTP+SSE using JSON-RPC 2.0.
type Client struct {
	baseURL    string
	token      string
	httpClient *http.Client
	nextID     atomic.Int64
}

// NewClient creates a new MCP client pointed at the given base URL with Bearer
// token authentication.
func NewClient(baseURL, token string) *Client {
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		token:      token,
		httpClient: &http.Client{},
	}
}

// --- JSON-RPC 2.0 types ---

type jsonRPCRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int64  `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type jsonRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int64           `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *jsonRPCError   `json:"error,omitempty"`
}

type jsonRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *jsonRPCError) Error() string {
	return fmt.Sprintf("JSON-RPC error %d: %s", e.Code, e.Message)
}

// --- MCP protocol types ---

// MCPToolDef is a tool definition returned by MCP tools/list.
type MCPToolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

// MCPContent is a single content item in an MCP tool result.
type MCPContent struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

// MCPToolResult is the result of an MCP tools/call invocation.
type MCPToolResult struct {
	Content []MCPContent `json:"content"`
	IsError bool         `json:"isError,omitempty"`
}

// --- Client methods ---

// ListTools calls MCP tools/list and returns the available tool definitions.
func (c *Client) ListTools(ctx context.Context) ([]MCPToolDef, error) {
	raw, err := c.call(ctx, "tools/list", nil)
	if err != nil {
		return nil, fmt.Errorf("ListTools: %w", err)
	}

	var result struct {
		Tools []MCPToolDef `json:"tools"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("ListTools: unmarshal result: %w", err)
	}
	return result.Tools, nil
}

// CallTool calls MCP tools/call to execute a tool by name with the given arguments.
func (c *Client) CallTool(ctx context.Context, name string, args map[string]any) (*MCPToolResult, error) {
	params := map[string]any{
		"name":      name,
		"arguments": args,
	}
	raw, err := c.call(ctx, "tools/call", params)
	if err != nil {
		return nil, fmt.Errorf("CallTool(%s): %w", name, err)
	}

	var result MCPToolResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("CallTool(%s): unmarshal result: %w", name, err)
	}
	return &result, nil
}

// call sends a JSON-RPC request to the MCP server and parses the SSE response.
func (c *Client) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := c.nextID.Add(1)

	reqBody := jsonRPCRequest{
		JSONRPC: "2.0",
		ID:      id,
		Method:  method,
		Params:  params,
	}
	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
	}

	contentType := resp.Header.Get("Content-Type")
	if strings.HasPrefix(contentType, "text/event-stream") {
		return c.parseSSE(resp.Body, id)
	}
	// Fallback: plain JSON-RPC response.
	return c.parseJSON(resp.Body, id)
}

// parseSSE reads an SSE stream and extracts the JSON-RPC response matching our request ID.
func (c *Client) parseSSE(r io.Reader, requestID int64) (json.RawMessage, error) {
	scanner := bufio.NewScanner(r)
	var dataLines []string

	for scanner.Scan() {
		line := scanner.Text()

		if strings.HasPrefix(line, "data: ") {
			dataLines = append(dataLines, strings.TrimPrefix(line, "data: "))
			continue
		}

		// Empty line = end of event; process accumulated data.
		if line == "" && len(dataLines) > 0 {
			data := strings.Join(dataLines, "\n")
			dataLines = nil

			result, done, err := c.processSSEData(data, requestID)
			if err != nil {
				return nil, err
			}
			if done {
				return result, nil
			}
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("SSE scan: %w", err)
	}

	// Process any remaining data lines (stream closed without trailing newline).
	if len(dataLines) > 0 {
		data := strings.Join(dataLines, "\n")
		result, done, err := c.processSSEData(data, requestID)
		if err != nil {
			return nil, err
		}
		if done {
			return result, nil
		}
	}

	return nil, fmt.Errorf("SSE stream ended without a response for request %d", requestID)
}

// processSSEData attempts to parse a JSON-RPC response from SSE data.
func (c *Client) processSSEData(data string, requestID int64) (json.RawMessage, bool, error) {
	var rpcResp jsonRPCResponse
	if err := json.Unmarshal([]byte(data), &rpcResp); err != nil {
		// Not a JSON-RPC message; skip (could be a keep-alive or other event).
		return nil, false, nil
	}
	if rpcResp.ID != requestID {
		return nil, false, nil
	}
	if rpcResp.Error != nil {
		return nil, true, rpcResp.Error
	}
	return rpcResp.Result, true, nil
}

// parseJSON reads a plain JSON-RPC response body.
func (c *Client) parseJSON(r io.Reader, requestID int64) (json.RawMessage, error) {
	body, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("read response body: %w", err)
	}

	var rpcResp jsonRPCResponse
	if err := json.Unmarshal(body, &rpcResp); err != nil {
		return nil, fmt.Errorf("unmarshal JSON-RPC response: %w", err)
	}
	if rpcResp.ID != requestID {
		return nil, fmt.Errorf("response ID mismatch: got %d, want %d", rpcResp.ID, requestID)
	}
	if rpcResp.Error != nil {
		return nil, rpcResp.Error
	}
	return rpcResp.Result, nil
}
