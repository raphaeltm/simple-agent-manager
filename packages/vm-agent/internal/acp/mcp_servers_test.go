package acp

import (
	"testing"
)

func TestBuildAcpMcpServers_Empty(t *testing.T) {
	result := buildAcpMcpServers(nil)
	if len(result) != 0 {
		t.Fatalf("expected empty slice, got %d entries", len(result))
	}

	result = buildAcpMcpServers([]McpServerEntry{})
	if len(result) != 0 {
		t.Fatalf("expected empty slice, got %d entries", len(result))
	}
}

func TestBuildAcpMcpServers_SingleServer(t *testing.T) {
	entries := []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "test-token-123"},
	}

	result := buildAcpMcpServers(entries)

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
	if server.Http.Type != "streamable-http" {
		t.Errorf("expected type 'streamable-http', got '%s'", server.Http.Type)
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

	result := buildAcpMcpServers(entries)

	if len(result) != 1 {
		t.Fatalf("expected 1 server, got %d", len(result))
	}

	server := result[0]
	if len(server.Http.Headers) != 0 {
		t.Errorf("expected 0 headers for empty token, got %d", len(server.Http.Headers))
	}
}

func TestBuildAcpMcpServers_MultipleServers(t *testing.T) {
	entries := []McpServerEntry{
		{URL: "https://api1.example.com/mcp", Token: "token-1"},
		{URL: "https://api2.example.com/mcp", Token: "token-2"},
	}

	result := buildAcpMcpServers(entries)

	if len(result) != 2 {
		t.Fatalf("expected 2 servers, got %d", len(result))
	}
	if result[0].Http.Url != "https://api1.example.com/mcp" {
		t.Errorf("expected first URL 'https://api1.example.com/mcp', got '%s'", result[0].Http.Url)
	}
	if result[1].Http.Url != "https://api2.example.com/mcp" {
		t.Errorf("expected second URL 'https://api2.example.com/mcp', got '%s'", result[1].Http.Url)
	}
}
