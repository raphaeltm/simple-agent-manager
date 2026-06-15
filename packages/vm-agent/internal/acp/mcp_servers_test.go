package acp

import (
	"encoding/json"
	"testing"
)

func TestBuildAcpMcpServers_Empty(t *testing.T) {
	result := buildAcpMcpServers(nil, "claude-code")
	if len(result) != 0 {
		t.Fatalf("expected empty slice, got %d entries", len(result))
	}

	result = buildAcpMcpServers([]McpServerEntry{}, "claude-code")
	if len(result) != 0 {
		t.Fatalf("expected empty slice, got %d entries", len(result))
	}
}

func TestBuildAcpMcpServers_SingleServer(t *testing.T) {
	entries := []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "test-token-123"},
	}

	result := buildAcpMcpServers(entries, "claude-code")

	if len(result) != 1 {
		t.Fatalf("expected 1 server, got %d", len(result))
	}

	server := result[0]
	if server.Http == nil {
		t.Fatal("expected Http transport, got nil")
	}
	if server.Http.Url != "https://api.example.com/mcp" {
		t.Errorf("expected URL 'https://api.example.com/mcp', got '%s'", server.Http.Url)
	}
	if server.Http.Name != "sam-mcp" {
		t.Errorf("expected name 'sam-mcp', got '%s'", server.Http.Name)
	}

	// Should have Authorization header
	if len(server.Http.Headers) != 1 {
		t.Fatalf("expected 1 header, got %d", len(server.Http.Headers))
	}
	if server.Http.Headers[0].Name != "Authorization" {
		t.Errorf("expected header name 'Authorization', got '%s'", server.Http.Headers[0].Name)
	}
	if server.Http.Headers[0].Value != "Bearer test-token-123" {
		t.Errorf("expected header value 'Bearer test-token-123', got '%s'", server.Http.Headers[0].Value)
	}
}

func TestBuildAcpMcpServers_NoToken(t *testing.T) {
	entries := []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: ""},
	}

	result := buildAcpMcpServers(entries, "claude-code")

	if len(result) != 1 {
		t.Fatalf("expected 1 server, got %d", len(result))
	}

	server := result[0]
	if len(server.Http.Headers) != 0 {
		t.Errorf("expected 0 headers for empty token, got %d", len(server.Http.Headers))
	}
}

func TestBuildAcpMcpServers_CodexUsesConfigTomlOnly(t *testing.T) {
	entries := []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "test-token-123"},
	}

	result := buildAcpMcpServers(entries, "openai-codex")

	if len(result) != 0 {
		t.Fatalf("expected no ACP-injected MCP servers for Codex, got %d", len(result))
	}
}

func TestBuildAcpMcpServers_MultipleServers(t *testing.T) {
	entries := []McpServerEntry{
		{URL: "https://api1.example.com/mcp", Token: "token-1"},
		{URL: "https://api2.example.com/mcp", Token: "token-2"},
	}

	result := buildAcpMcpServers(entries, "claude-code")

	if len(result) != 2 {
		t.Fatalf("expected 2 servers, got %d", len(result))
	}
	if result[0].Http.Url != "https://api1.example.com/mcp" {
		t.Errorf("expected first URL 'https://api1.example.com/mcp', got '%s'", result[0].Http.Url)
	}
	if result[1].Http.Url != "https://api2.example.com/mcp" {
		t.Errorf("expected second URL 'https://api2.example.com/mcp', got '%s'", result[1].Http.Url)
	}

	// Multiple servers should have unique names
	if result[0].Http.Name == result[1].Http.Name {
		t.Errorf("expected unique names, got duplicate: %q", result[0].Http.Name)
	}
}

func TestBuildAcpMcpServers_WireFormat(t *testing.T) {
	entries := []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "tok"},
	}
	result := buildAcpMcpServers(entries, "claude-code")

	b, err := json.Marshal(result[0])
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	// The ACP SDK's MarshalJSON sets type to "http" regardless of the struct field
	if m["type"] != "http" {
		t.Errorf("wire type should be 'http', got %q", m["type"])
	}
}

func TestBuildAcpMcpServers_AmpUsesMcpRemoteStdioBridge(t *testing.T) {
	entries := []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "tok"},
	}
	result := buildAcpMcpServers(entries, "amp")

	if len(result) != 1 {
		t.Fatalf("expected 1 server, got %d", len(result))
	}

	server := result[0]
	if server.Http != nil {
		t.Fatal("expected Amp MCP server to avoid HTTP transport")
	}
	if server.Stdio == nil {
		t.Fatal("expected Stdio transport, got nil")
	}
	if server.Stdio.Name != "sam-mcp" {
		t.Errorf("expected name 'sam-mcp', got '%s'", server.Stdio.Name)
	}
	if server.Stdio.Command != "npx" {
		t.Errorf("expected command 'npx', got '%s'", server.Stdio.Command)
	}

	wantArgs := []string{
		"-y",
		"mcp-remote@0.1.38",
		"https://api.example.com/mcp",
		"--header",
		"Authorization:Bearer ${SAM_MCP_TOKEN}",
		"--silent",
	}
	if len(server.Stdio.Args) != len(wantArgs) {
		t.Fatalf("args length=%d, want %d: %#v", len(server.Stdio.Args), len(wantArgs), server.Stdio.Args)
	}
	for i := range wantArgs {
		if server.Stdio.Args[i] != wantArgs[i] {
			t.Fatalf("arg[%d]=%q, want %q", i, server.Stdio.Args[i], wantArgs[i])
		}
	}

	if len(server.Stdio.Env) != 1 {
		t.Fatalf("expected 1 env var, got %d", len(server.Stdio.Env))
	}
	if server.Stdio.Env[0].Name != "SAM_MCP_TOKEN" {
		t.Errorf("env name=%q, want SAM_MCP_TOKEN", server.Stdio.Env[0].Name)
	}
	if server.Stdio.Env[0].Value != "tok" {
		t.Errorf("env value=%q, want token", server.Stdio.Env[0].Value)
	}
}

func TestBuildAcpMcpServers_AmpNoTokenOmitsHeaderArg(t *testing.T) {
	entries := []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: ""},
	}
	result := buildAcpMcpServers(entries, "amp")

	if len(result) != 1 {
		t.Fatalf("expected 1 server, got %d", len(result))
	}
	server := result[0]
	if server.Stdio == nil {
		t.Fatal("expected Stdio transport")
	}
	// No env vars when token is empty
	if len(server.Stdio.Env) != 0 {
		t.Fatalf("expected 0 env vars when token is empty, got %d", len(server.Stdio.Env))
	}
	// --header arg should not be present
	for _, arg := range server.Stdio.Args {
		if arg == "--header" {
			t.Fatal("--header should not be present when token is empty")
		}
	}
	// Should still have: -y, mcp-remote@version, URL, --silent
	wantArgs := []string{"-y", "mcp-remote@0.1.38", "https://api.example.com/mcp", "--silent"}
	if len(server.Stdio.Args) != len(wantArgs) {
		t.Fatalf("args=%v, want %v", server.Stdio.Args, wantArgs)
	}
}

func TestBuildAcpMcpServers_AmpWireFormatDoesNotExposeTokenInArgs(t *testing.T) {
	entries := []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "secret-token"},
	}
	result := buildAcpMcpServers(entries, "amp")

	b, err := json.Marshal(result[0])
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	if m["type"] != nil {
		t.Errorf("stdio wire format should not include type, got %q", m["type"])
	}
	args, ok := m["args"].([]interface{})
	if !ok {
		t.Fatalf("expected args array, got %#v", m["args"])
	}
	for _, arg := range args {
		if arg == "secret-token" || arg == "Authorization:Bearer secret-token" {
			t.Fatalf("token leaked in stdio args: %#v", args)
		}
	}
}
