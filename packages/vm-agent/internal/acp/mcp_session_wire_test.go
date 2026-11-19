package acp

import (
	"context"
	"encoding/json"
	"io"
	"reflect"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// Capture the SDK's actual JSON-RPC output from both production session paths.
// Decoding into SDK structs would lose the distinction between null and [].
func TestSessionMcpRequiredArraysOnWire(t *testing.T) {
	sam := McpServerEntry{Name: SamMcpServerName, URL: "https://sam.example/mcp", Token: "fixture-token"}
	headerless := McpServerEntry{Name: "public-tools", URL: "https://public.example/mcp"}
	custom := McpServerEntry{Name: "custom-tools", URL: "https://custom.example/mcp", Token: "fixture-custom-token",
		Headers: []McpHeader{{Name: "x-api-key", Value: "fixture-header-value"}}}
	customOnly := McpServerEntry{Name: "custom-only", URL: "https://custom-only.example/mcp",
		Headers: []McpHeader{{Name: "x-api-key", Value: "fixture-header-only"}}}

	for _, method := range []string{"session/new", "session/load"} {
		for _, agentType := range []string{"mistral-vibe", "claude-code", "amp"} {
			for _, tc := range []struct {
				name    string
				entries []McpServerEntry
			}{
				{"mixed", []McpServerEntry{sam, headerless}},
				{"populated", []McpServerEntry{sam, custom, customOnly}},
				{"nil-servers", nil},
				{"empty-servers", []McpServerEntry{}},
			} {
				t.Run(method+"/"+agentType+"/"+tc.name, func(t *testing.T) {
					params := captureSessionMcpWireRequest(t, method, agentType, tc.entries)
					servers := requireMcpWireArray(t, params, "mcpServers", len(tc.entries))
					for i, entry := range tc.entries {
						server, ok := servers[i].(map[string]any)
						if !ok {
							t.Fatal("MCP server must be a JSON object")
						}
						if server["name"] != entry.Name {
							t.Errorf("server name = %v, want %s", server["name"], entry.Name)
						}
						if agentType == "amp" {
							assertAmpMcpWireServer(t, server, entry)
						} else {
							if server["type"] != "http" || server["url"] != entry.URL {
								t.Error("HTTP transport or URL changed")
							}
							want := []any{}
							if entry.Token != "" {
								want = append(want, map[string]any{"name": "Authorization", "value": "Bearer " + entry.Token})
							}
							for _, header := range entry.Headers {
								want = append(want, map[string]any{"name": header.Name, "value": header.Value})
							}
							if got := requireMcpWireArray(t, server, "headers", len(want)); !reflect.DeepEqual(got, want) {
								t.Error("HTTP auth/custom headers changed")
							}
						}
					}
				})
			}
		}
	}
}

func requireMcpWireArray(t *testing.T, object map[string]any, key string, length int) []any {
	t.Helper()
	value, ok := object[key].([]any)
	if !ok {
		t.Fatalf("%s must be a JSON array, got %T (missing/null is invalid)", key, object[key])
	}
	if len(value) != length {
		t.Fatalf("%s length = %d, want %d", key, len(value), length)
	}
	return value
}

func assertAmpMcpWireServer(t *testing.T, server map[string]any, entry McpServerEntry) {
	t.Helper()
	if _, hasType := server["type"]; hasType || server["command"] != "npx" {
		t.Error("Amp stdio transport changed")
	}
	wantEnv := []any{}
	wantArgs := []any{"-y", "mcp-remote@0.1.38", entry.URL}
	if entry.Token != "" {
		wantEnv = append(wantEnv, map[string]any{"name": "SAM_MCP_TOKEN", "value": entry.Token})
		wantArgs = append(wantArgs, "--header", "Authorization:Bearer ${SAM_MCP_TOKEN}")
	}
	// Fixtures have at most one custom header. Exact argv equality also proves
	// token and custom-header values never become command-line arguments.
	for _, header := range entry.Headers {
		wantEnv = append(wantEnv, map[string]any{"name": "SAM_MCP_HEADER_0", "value": header.Value})
		wantArgs = append(wantArgs, "--header", header.Name+":${SAM_MCP_HEADER_0}")
	}
	wantArgs = append(wantArgs, "--silent")
	if got := requireMcpWireArray(t, server, "env", len(wantEnv)); !reflect.DeepEqual(got, wantEnv) {
		t.Error("Amp auth/custom env changed")
	}
	if got := requireMcpWireArray(t, server, "args", len(wantArgs)); !reflect.DeepEqual(got, wantArgs) {
		t.Error("Amp bridge arguments changed or contain secret values")
	}
}

func captureSessionMcpWireRequest(t *testing.T, method, agentType string, entries []McpServerEntry) map[string]any {
	t.Helper()
	clientReader, clientWriter := io.Pipe()
	agentReader, agentWriter := io.Pipe()
	t.Cleanup(func() {
		_ = clientReader.Close()
		_ = clientWriter.Close()
		_ = agentReader.Close()
		_ = agentWriter.Close()
	})
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{ContainerWorkDir: "/workspace"}})
	host.SetMcpServers(entries)
	host.acpConn = acpsdk.NewClientSideConnection(&sessionHostClient{host: host}, clientWriter, agentReader)

	type wireRequest struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params map[string]any  `json:"params"`
	}
	captured := make(chan wireRequest, 1)
	agentDone := make(chan error, 1)
	go func() {
		var request wireRequest
		if err := json.NewDecoder(clientReader).Decode(&request); err != nil {
			agentDone <- err
			return
		}
		captured <- request
		result := map[string]any{}
		if request.Method == "session/new" {
			result["sessionId"] = "fixture-session"
		}
		agentDone <- json.NewEncoder(agentWriter).Encode(map[string]any{
			"jsonrpc": "2.0", "id": request.ID, "result": result,
		})
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	host.mu.Lock() // production holds the host lock during the session handshake
	var err error
	if method == "session/new" {
		err = host.startNewACPSession(ctx, agentType, nil, 5*time.Second)
	} else {
		var loaded bool
		loaded, err = host.tryLoadPreviousACPSession(ctx, agentType, nil, "fixture-session", true, 5*time.Second, false)
		if err == nil && !loaded {
			t.Error("LoadSession did not restore the session")
		}
	}
	host.mu.Unlock()
	if err != nil {
		t.Fatalf("session request failed: %v", err)
	}
	if err := <-agentDone; err != nil {
		t.Fatalf("fixture response failed: %v", err)
	}
	request := <-captured
	if request.Method != method || request.Params["cwd"] != "/workspace" || host.sessionID != "fixture-session" {
		t.Fatal("session request/response control failed")
	}
	if method == "session/load" && request.Params["sessionId"] != "fixture-session" {
		t.Error("LoadSession lost the previous session ID")
	}
	return request.Params
}
