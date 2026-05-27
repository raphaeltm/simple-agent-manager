package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// multiResponseDoer returns different responses based on request URL path.
type multiResponseDoer struct {
	responses map[string]struct {
		body   string
		status int
	}
	requests []capturedRequest
}

func (m *multiResponseDoer) Do(req *http.Request) (*http.Response, error) {
	captured := capturedRequest{
		Method:  req.Method,
		URL:     req.URL.String(),
		Headers: req.Header.Clone(),
	}
	m.requests = append(m.requests, captured)

	for pattern, resp := range m.responses {
		if strings.Contains(req.URL.Path, pattern) {
			return jsonResponse(resp.body, resp.status), nil
		}
	}
	return jsonResponse(`{"error":"NOT_FOUND","message":"no mock for path"}`, http.StatusNotFound), nil
}

func TestWorkspaceRequiresArgs(t *testing.T) {
	runtime, _, stderr := testRuntime(t, []string{"workspace"}, nil, nil)
	code := Run(context.Background(), runtime)
	if code != 1 {
		t.Fatalf("expected exit code 1, got %d", code)
	}
	if !strings.Contains(stderr.String(), "usage: sam workspace") {
		t.Fatalf("expected usage message, got: %s", stderr.String())
	}
}

func TestWorkspaceRequiresAction(t *testing.T) {
	runtime, _, stderr := testRuntime(t, []string{"workspace", "ws-123"}, nil, nil)
	code := Run(context.Background(), runtime)
	if code != 1 {
		t.Fatalf("expected exit code 1, got %d", code)
	}
	if !strings.Contains(stderr.String(), "usage: sam workspace") {
		t.Fatalf("expected usage message, got: %s", stderr.String())
	}
}

func TestWorkspaceUnknownAction(t *testing.T) {
	runtime, _, stderr := testRuntime(t, []string{"workspace", "ws-123", "unknown"}, nil, nil)
	code := Run(context.Background(), runtime)
	if code != 1 {
		t.Fatalf("expected exit code 1, got %d", code)
	}
	if !strings.Contains(stderr.String(), "unknown workspace action: unknown") {
		t.Fatalf("expected unknown action error, got: %s", stderr.String())
	}
}

func TestWorkspacePortsListsDetectedPorts(t *testing.T) {
	portsJSON := `{"ports":[{"port":3000,"address":"0.0.0.0","label":"Vite dev server","url":"https://ws-abc123--3000.example.com","detectedAt":"2026-05-27T10:30:00Z"},{"port":8080,"address":"0.0.0.0","label":"API server","url":"https://ws-abc123--8080.example.com","detectedAt":"2026-05-27T10:31:00Z"}]}`
	doer, captured := captureJSONRequest(t, portsJSON, http.StatusOK)
	runtime, stdout, _ := testRuntime(t, []string{"workspace", "ws-abc123", "ports"}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("expected exit code 0, got %d", code)
	}
	if captured.URL != "https://api.example.com/api/workspaces/ws-abc123/ports" {
		t.Fatalf("unexpected URL: %s", captured.URL)
	}
	output := stdout.String()
	if !strings.Contains(output, "3000") || !strings.Contains(output, "Vite dev server") {
		t.Fatalf("expected port listing in output, got: %s", output)
	}
	if !strings.Contains(output, "8080") || !strings.Contains(output, "API server") {
		t.Fatalf("expected port 8080 in output, got: %s", output)
	}
}

func TestWorkspacePortsEmptyList(t *testing.T) {
	doer, _ := captureJSONRequest(t, `{"ports":[]}`, http.StatusOK)
	runtime, stdout, _ := testRuntime(t, []string{"workspace", "ws-abc123", "ports"}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("expected exit code 0, got %d", code)
	}
	if !strings.Contains(stdout.String(), "No ports detected") {
		t.Fatalf("expected 'No ports detected' message, got: %s", stdout.String())
	}
}

func TestWorkspacePortsJSON(t *testing.T) {
	portsJSON := `{"ports":[{"port":3000,"address":"0.0.0.0","label":"dev","url":"https://ws-abc123--3000.example.com","detectedAt":"2026-05-27T10:30:00Z"}]}`
	doer, _ := captureJSONRequest(t, portsJSON, http.StatusOK)
	runtime, stdout, _ := testRuntime(t, []string{"workspace", "ws-abc123", "ports", "--json"}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("expected exit code 0, got %d", code)
	}
	var result PortsResponse
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, stdout.String())
	}
	if len(result.Ports) != 1 || result.Ports[0].Port != 3000 {
		t.Fatalf("unexpected JSON output: %+v", result)
	}
}

func TestWorkspacePortsAPIError(t *testing.T) {
	doer, _ := captureJSONRequest(t, `{"error":"NOT_FOUND","message":"Workspace not found"}`, http.StatusNotFound)
	runtime, _, stderr := testRuntime(t, []string{"workspace", "ws-missing", "ports"}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 1 {
		t.Fatalf("expected exit code 1, got %d", code)
	}
	if !strings.Contains(stderr.String(), "Workspace not found") {
		t.Fatalf("expected error message, got: %s", stderr.String())
	}
}

func TestWorkspaceForwardRequiresAuth(t *testing.T) {
	runtime, _, stderr := testRuntime(t, []string{"workspace", "ws-123", "forward"}, nil, map[string]string{})
	code := Run(context.Background(), runtime)
	if code != 1 {
		t.Fatalf("expected exit code 1, got %d", code)
	}
	if !strings.Contains(stderr.String(), "not authenticated") {
		t.Fatalf("expected auth error, got: %s", stderr.String())
	}
}

func TestWorkspaceForwardRejectsNotRunning(t *testing.T) {
	doer := &multiResponseDoer{
		responses: map[string]struct {
			body   string
			status int
		}{
			"/api/workspaces/ws-stopped": {
				body:   `{"id":"ws-stopped","url":"https://ws-stopped.example.com","status":"stopped","nodeId":"node-1"}`,
				status: http.StatusOK,
			},
		},
	}
	runtime, _, stderr := testRuntime(t, []string{"workspace", "ws-stopped", "forward", "--port", "3000"}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 1 {
		t.Fatalf("expected exit code 1, got %d", code)
	}
	if !strings.Contains(stderr.String(), "workspace is stopped") {
		t.Fatalf("expected status error, got: %s", stderr.String())
	}
}

func TestWorkspaceForwardParsesMultiplePorts(t *testing.T) {
	// Test that --port flags are collected correctly
	parsed, err := parseArgs([]string{"workspace", "ws-123", "forward", "--port", "3000", "--port", "8080"})
	if err != nil {
		t.Fatalf("parseArgs failed: %v", err)
	}
	ports, err := parsePortFlags(parsed)
	if err != nil {
		t.Fatalf("parsePortFlags failed: %v", err)
	}
	if len(ports) != 2 || ports[0] != 3000 || ports[1] != 8080 {
		t.Fatalf("expected [3000, 8080], got %v", ports)
	}
}

func TestWorkspaceForwardParsesPortEquals(t *testing.T) {
	parsed, err := parseArgs([]string{"workspace", "ws-123", "forward", "--port=4000"})
	if err != nil {
		t.Fatalf("parseArgs failed: %v", err)
	}
	ports, err := parsePortFlags(parsed)
	if err != nil {
		t.Fatalf("parsePortFlags failed: %v", err)
	}
	if len(ports) != 1 || ports[0] != 4000 {
		t.Fatalf("expected [4000], got %v", ports)
	}
}

func TestWorkspaceForwardRejectsInvalidPort(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{"zero", []string{"workspace", "ws-123", "forward", "--port", "0"}},
		{"negative", []string{"workspace", "ws-123", "forward", "--port", "-1"}},
		{"too high", []string{"workspace", "ws-123", "forward", "--port", "99999"}},
		{"non-numeric", []string{"workspace", "ws-123", "forward", "--port", "abc"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			doer := &multiResponseDoer{
				responses: map[string]struct {
					body   string
					status int
				}{
					"/api/workspaces/ws-123": {
						body:   `{"id":"ws-123","url":"https://ws-123.example.com","status":"running","nodeId":"node-1"}`,
						status: http.StatusOK,
					},
				},
			}
			runtime, _, stderr := testRuntime(t, tt.args, doer, nil)
			code := Run(context.Background(), runtime)
			if code != 1 {
				t.Fatalf("expected exit code 1, got %d", code)
			}
			if !strings.Contains(stderr.String(), "invalid port") {
				t.Fatalf("expected invalid port error, got: %s", stderr.String())
			}
		})
	}
}

func TestWorkspaceForwardNoPortsDetected(t *testing.T) {
	doer := &multiResponseDoer{
		responses: map[string]struct {
			body   string
			status int
		}{
			"/ports": {
				body:   `{"ports":[]}`,
				status: http.StatusOK,
			},
			"/api/workspaces/ws-empty": {
				body:   `{"id":"ws-empty","url":"https://ws-empty.example.com","status":"running","nodeId":"node-1"}`,
				status: http.StatusOK,
			},
		},
	}
	runtime, _, stderr := testRuntime(t, []string{"workspace", "ws-empty", "forward"}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 1 {
		t.Fatalf("expected exit code 1, got %d", code)
	}
	if !strings.Contains(stderr.String(), "no ports detected") {
		t.Fatalf("expected no ports error, got: %s", stderr.String())
	}
}

func TestExtractBaseDomain(t *testing.T) {
	tests := []struct {
		url    string
		domain string
		err    bool
	}{
		{"https://ws-abc123.simple-agent-manager.org", "simple-agent-manager.org", false},
		{"https://ws-abc123.sammy.party", "sammy.party", false},
		{"https://nodomain", "", true},
		{"", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.url, func(t *testing.T) {
			domain, err := extractBaseDomain(tt.url)
			if tt.err && err == nil {
				t.Fatal("expected error")
			}
			if !tt.err && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if domain != tt.domain {
				t.Fatalf("expected %q, got %q", tt.domain, domain)
			}
		})
	}
}

func TestFormatPortsList(t *testing.T) {
	ports := PortsResponse{
		Ports: []DetectedPort{
			{Port: 3000, Label: "Vite", URL: "https://ws-abc--3000.example.com"},
			{Port: 8080, Label: "", URL: "https://ws-abc--8080.example.com"},
		},
	}
	output := formatPortsList(ports)
	if !strings.Contains(output, "3000") || !strings.Contains(output, "Vite") {
		t.Fatalf("expected port 3000 with label, got: %s", output)
	}
	if !strings.Contains(output, "8080") || !strings.Contains(output, "unknown") {
		t.Fatalf("expected port 8080 with 'unknown' label, got: %s", output)
	}
}

func TestMultiFlagsCollectsRepeatedFlags(t *testing.T) {
	parsed, err := parseArgs([]string{"workspace", "ws-1", "forward", "--port", "3000", "--port", "8080", "--port", "9090"})
	if err != nil {
		t.Fatalf("parseArgs failed: %v", err)
	}
	values := flagValues(parsed.MultiFlags, "port")
	if len(values) != 3 {
		t.Fatalf("expected 3 port values, got %d: %v", len(values), values)
	}
	expected := []string{"3000", "8080", "9090"}
	for i, v := range values {
		if v != expected[i] {
			t.Fatalf("port[%d]: expected %s, got %s", i, expected[i], v)
		}
	}
}

func TestMultiFlagsEqualsForm(t *testing.T) {
	parsed, err := parseArgs([]string{"workspace", "ws-1", "forward", "--port=3000", "--port=8080"})
	if err != nil {
		t.Fatalf("parseArgs failed: %v", err)
	}
	values := flagValues(parsed.MultiFlags, "port")
	if len(values) != 2 {
		t.Fatalf("expected 2 port values, got %d: %v", len(values), values)
	}
}

func TestMultiFlagsBackwardCompatible(t *testing.T) {
	// Verify that single-value Flags still works (last value wins)
	parsed, err := parseArgs([]string{"task", "submit", "--agent", "claude-code"})
	if err != nil {
		t.Fatalf("parseArgs failed: %v", err)
	}
	if flagValue(parsed.Flags, "agent") != "claude-code" {
		t.Fatalf("expected agent=claude-code, got %s", flagValue(parsed.Flags, "agent"))
	}
}

func TestHelpIncludesWorkspaceCommands(t *testing.T) {
	runtime, stdout, _ := testRuntime(t, []string{"--help"}, nil, nil)
	code := Run(context.Background(), runtime)
	if code != 0 {
		t.Fatalf("expected exit code 0, got %d", code)
	}
	output := stdout.String()
	if !strings.Contains(output, "workspace") {
		t.Fatalf("help text should mention workspace commands, got: %s", output)
	}
	if !strings.Contains(output, "forward") || !strings.Contains(output, "ports") {
		t.Fatalf("help text should mention forward and ports, got: %s", output)
	}
}

func TestTokenCacheRefreshesExpiredToken(t *testing.T) {
	calls := 0
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		return jsonResponse(`{"token":"tok-`+string(rune('0'+calls))+`","url":"https://example.com","port":3000}`, http.StatusOK), nil
	})
	client := NewAPIClient(CLIConfig{APIURL: "https://api.example.com", SessionCookie: "test"}, doer)

	tc := &tokenCache{
		client:      client,
		workspaceID: "ws-1",
		port:        3000,
	}

	// First call should fetch a token
	tok1, err := tc.getToken(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tok1 == "" {
		t.Fatal("expected non-empty token")
	}

	// Second call should use cached token
	tok2, err := tc.getToken(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tok2 != tok1 {
		t.Fatalf("expected cached token %q, got %q", tok1, tok2)
	}
	if calls != 1 {
		t.Fatalf("expected 1 API call, got %d", calls)
	}
}

// Verify the workspace client methods construct correct URLs.
func TestClientGetWorkspaceURL(t *testing.T) {
	doer, captured := captureJSONRequest(t, `{"id":"ws-abc","status":"running"}`, http.StatusOK)
	client := NewAPIClient(CLIConfig{APIURL: "https://api.example.com", SessionCookie: "test"}, doer)

	_, err := client.GetWorkspace(context.Background(), "ws-abc")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if captured.URL != "https://api.example.com/api/workspaces/ws-abc" {
		t.Fatalf("unexpected URL: %s", captured.URL)
	}
}

func TestClientGetWorkspacePortsURL(t *testing.T) {
	doer, captured := captureJSONRequest(t, `{"ports":[]}`, http.StatusOK)
	client := NewAPIClient(CLIConfig{APIURL: "https://api.example.com", SessionCookie: "test"}, doer)

	_, err := client.GetWorkspacePorts(context.Background(), "ws-abc")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if captured.URL != "https://api.example.com/api/workspaces/ws-abc/ports" {
		t.Fatalf("unexpected URL: %s", captured.URL)
	}
}

func TestClientGetPortTokenURL(t *testing.T) {
	doer, captured := captureJSONRequest(t, `{"token":"tok","url":"https://example.com","port":3000}`, http.StatusOK)
	client := NewAPIClient(CLIConfig{APIURL: "https://api.example.com", SessionCookie: "test"}, doer)

	_, err := client.GetPortToken(context.Background(), "ws-abc", 3000)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if captured.URL != "https://api.example.com/api/workspaces/ws-abc/port-access?port=3000" {
		t.Fatalf("unexpected URL: %s", captured.URL)
	}
}

// Verify Accept: application/json header is set on port-token request.
func TestClientGetPortTokenSetsAcceptJSON(t *testing.T) {
	doer, captured := captureJSONRequest(t, `{"token":"tok","url":"https://example.com","port":3000}`, http.StatusOK)
	client := NewAPIClient(CLIConfig{APIURL: "https://api.example.com", SessionCookie: "test"}, doer)

	_, _ = client.GetPortToken(context.Background(), "ws-abc", 3000)
	if captured.Headers.Get("Accept") != "application/json" {
		t.Fatalf("expected Accept: application/json, got: %s", captured.Headers.Get("Accept"))
	}
}

// Suppress unused import warning for bytes.
var _ = bytes.NewBuffer
