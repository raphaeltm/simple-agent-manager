package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// orderedResponse is a pattern-response pair for deterministic URL matching.
type orderedResponse struct {
	pattern string
	body    string
	status  int
}

// multiResponseDoer returns different responses based on request URL path.
// Patterns are matched in order (first match wins) for deterministic behavior.
type multiResponseDoer struct {
	responses []orderedResponse
	requests  []capturedRequest
}

func (m *multiResponseDoer) Do(req *http.Request) (*http.Response, error) {
	captured := capturedRequest{
		Method:  req.Method,
		URL:     req.URL.String(),
		Headers: req.Header.Clone(),
	}
	m.requests = append(m.requests, captured)

	for _, resp := range m.responses {
		if strings.Contains(req.URL.Path, resp.pattern) {
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

func TestWorkspacePortsRequiresAuth(t *testing.T) {
	runtime, _, stderr := testRuntime(t, []string{"workspace", "ws-123", "ports"}, nil, map[string]string{})
	code := Run(context.Background(), runtime)
	if code != 1 {
		t.Fatalf("expected exit code 1, got %d", code)
	}
	if !strings.Contains(stderr.String(), "not authenticated") {
		t.Fatalf("expected auth error, got: %s", stderr.String())
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
		responses: []orderedResponse{
			{"/api/workspaces/ws-stopped", `{"id":"ws-stopped","url":"https://ws-stopped.example.com","status":"stopped","nodeId":"node-1"}`, http.StatusOK},
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

func TestWorkspaceForwardAcceptsRecoveryStatus(t *testing.T) {
	// "recovery" is a valid status that should proceed (not rejected like "stopped")
	doer := &multiResponseDoer{
		responses: []orderedResponse{
			{"/api/workspaces/ws-recovery", `{"id":"ws-recovery","url":"https://ws-recovery.example.com","status":"recovery","nodeId":"node-1"}`, http.StatusOK},
			{"/ports", `{"ports":[]}`, http.StatusOK},
		},
	}
	runtime, _, stderr := testRuntime(t, []string{"workspace", "ws-recovery", "forward"}, doer, nil)

	code := Run(context.Background(), runtime)
	if code != 1 {
		t.Fatalf("expected exit code 1 (no ports detected, not status rejection), got %d", code)
	}
	// Should fail because no ports detected, NOT because status is invalid
	if !strings.Contains(stderr.String(), "no ports detected") {
		t.Fatalf("expected 'no ports detected' error (recovery is a valid status), got: %s", stderr.String())
	}
}

func TestWorkspaceForwardParsesMultiplePorts(t *testing.T) {
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
			// Port validation happens before any API call, so no mock needed
			runtime, _, stderr := testRuntime(t, tt.args, nil, nil)
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

func TestWorkspaceForwardParsesLocalForwardFlags(t *testing.T) {
	parsed, err := parseArgs([]string{"workspace", "ws-123", "forward", "--port", "5173", "--local-port", "3000", "--local-host", "127.0.0.1"})
	if err != nil {
		t.Fatalf("parseArgs failed: %v", err)
	}
	remotePorts, err := parsePortFlags(parsed)
	if err != nil {
		t.Fatalf("parsePortFlags failed: %v", err)
	}
	localPort, err := parseLocalPortFlag(parsed, remotePorts)
	if err != nil {
		t.Fatalf("parseLocalPortFlag failed: %v", err)
	}
	localHost, err := parseLocalHostFlag(parsed)
	if err != nil {
		t.Fatalf("parseLocalHostFlag failed: %v", err)
	}
	if localPort != 3000 {
		t.Fatalf("local port = %d, want 3000", localPort)
	}
	if localHost != "127.0.0.1" {
		t.Fatalf("local host = %q, want 127.0.0.1", localHost)
	}
}

func TestWorkspaceForwardRejectsInvalidLocalForwardFlags(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{
			name: "local port with multiple remote ports",
			args: []string{"workspace", "ws-123", "forward", "--port", "5173", "--port", "8080", "--local-port", "3000"},
			want: "--local-port can only be used",
		},
		{
			name: "invalid local host",
			args: []string{"workspace", "ws-123", "forward", "--port", "5173", "--local-host", "0.0.0.0"},
			want: "invalid local host",
		},
		{
			name: "invalid local port",
			args: []string{"workspace", "ws-123", "forward", "--port", "5173", "--local-port", "70000"},
			want: "invalid local port",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			parsed, err := parseArgs(tt.args)
			if err != nil {
				t.Fatalf("parseArgs failed: %v", err)
			}
			remotePorts, err := parsePortFlags(parsed)
			if err != nil {
				t.Fatalf("parsePortFlags failed: %v", err)
			}
			_, localPortErr := parseLocalPortFlag(parsed, remotePorts)
			_, localHostErr := parseLocalHostFlag(parsed)
			combined := fmt.Sprint(localPortErr, localHostErr)
			if !strings.Contains(combined, tt.want) {
				t.Fatalf("expected error containing %q, got port=%v host=%v", tt.want, localPortErr, localHostErr)
			}
		})
	}
}

func TestWorkspaceForwardNoPortsDetected(t *testing.T) {
	doer := &multiResponseDoer{
		responses: []orderedResponse{
			{"/api/workspaces/ws-empty/ports", `{"ports":[]}`, http.StatusOK},
			{"/api/workspaces/ws-empty", `{"id":"ws-empty","url":"https://ws-empty.example.com","status":"running","nodeId":"node-1"}`, http.StatusOK},
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
	if !strings.Contains(output, "https://ws-abc--3000.example.com") {
		t.Fatalf("expected URL in output, got: %s", output)
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
	if !strings.Contains(output, "--local-port") || !strings.Contains(output, "--local-host") {
		t.Fatalf("help text should mention local forward flags, got: %s", output)
	}
}

func TestTokenCacheRefreshesExpiredToken(t *testing.T) {
	calls := 0
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		return jsonResponse(`{"token":"tok-`+string(rune('0'+calls))+`","expiresAt":"2026-06-20T00:00:00Z","remotePort":3000,"mode":"http","localAuthority":"localhost:3000"}`, http.StatusOK), nil
	})
	client := NewAPIClient(CLIConfig{APIURL: "https://api.example.com", SessionCookie: "test"}, doer)

	tc := &tokenCache{
		client:         client,
		workspaceID:    "ws-1",
		remotePort:     3000,
		localAuthority: "localhost:3000",
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

	// Force expiry by setting expiresAt to the past
	tc.expiresAt = time.Now().Add(-1 * time.Second)

	// Third call should fetch a new token
	tok3, err := tc.getToken(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tok3 == tok1 {
		t.Fatalf("expected new token after expiry, got same token %q", tok3)
	}
	if calls != 2 {
		t.Fatalf("expected 2 API calls after expiry, got %d", calls)
	}
}

func TestTokenCacheReturnsErrorOnAPIFailure(t *testing.T) {
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(`{"error":"UNAUTHORIZED","message":"Invalid session"}`, http.StatusUnauthorized), nil
	})
	client := NewAPIClient(CLIConfig{APIURL: "https://api.example.com", SessionCookie: "test"}, doer)

	tc := &tokenCache{
		client:         client,
		workspaceID:    "ws-1",
		remotePort:     3000,
		localAuthority: "localhost:3000",
	}

	_, err := tc.getToken(context.Background())
	if err == nil {
		t.Fatal("expected error from getToken when API returns error")
	}
	if !strings.Contains(err.Error(), "Invalid session") {
		t.Fatalf("expected API error message, got: %v", err)
	}
}

func TestLocalForwardRefreshTimeUsesAPIExpiry(t *testing.T) {
	expiresAt := time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339)
	refreshAt := localForwardRefreshTime(expiresAt)
	if time.Until(refreshAt) < 8*time.Minute || time.Until(refreshAt) > 10*time.Minute {
		t.Fatalf("expected refresh roughly one minute before API expiry, got %s", refreshAt)
	}

	stale := time.Now().Add(30 * time.Second).UTC().Format(time.RFC3339)
	refreshAt = localForwardRefreshTime(stale)
	if time.Until(refreshAt) > 10*time.Second {
		t.Fatalf("expected near-immediate refresh for short/stale expiry, got %s", refreshAt)
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

func TestClientGetPortTokenSetsAcceptJSON(t *testing.T) {
	doer, captured := captureJSONRequest(t, `{"token":"tok","url":"https://example.com","port":3000}`, http.StatusOK)
	client := NewAPIClient(CLIConfig{APIURL: "https://api.example.com", SessionCookie: "test"}, doer)

	_, _ = client.GetPortToken(context.Background(), "ws-abc", 3000)
	if captured.Headers.Get("Accept") != "application/json" {
		t.Fatalf("expected Accept: application/json, got: %s", captured.Headers.Get("Accept"))
	}
}

func TestClientCreateLocalForwardSessionContract(t *testing.T) {
	doer, captured := captureJSONRequest(t, `{"token":"tok","expiresAt":"2026-06-20T00:00:00Z","workspaceId":"ws-abc","nodeId":"node-1","remotePort":5173,"mode":"http","localAuthority":"localhost:3000","forwardPath":"/api/workspaces/ws-abc/local-forward/5173"}`, http.StatusOK)
	client := NewAPIClient(CLIConfig{APIURL: "https://api.example.com", SessionCookie: "test"}, doer)

	resp, err := client.CreateLocalForwardSession(context.Background(), "ws-abc", LocalForwardSessionRequest{
		RemotePort:     5173,
		Mode:           "http",
		LocalAuthority: "localhost:3000",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if captured.Method != http.MethodPost {
		t.Fatalf("method = %s, want POST", captured.Method)
	}
	if captured.URL != "https://api.example.com/api/workspaces/ws-abc/forwards" {
		t.Fatalf("unexpected URL: %s", captured.URL)
	}
	if captured.JSON["remotePort"] != float64(5173) ||
		captured.JSON["mode"] != "http" ||
		captured.JSON["localAuthority"] != "localhost:3000" {
		t.Fatalf("unexpected request JSON: %+v", captured.JSON)
	}
	if resp.Token != "tok" || resp.RemotePort != 5173 || resp.LocalAuthority != "localhost:3000" {
		t.Fatalf("unexpected response: %+v", resp)
	}
}

// --- Tests for startForwarders and acceptConnections (previously 0% coverage) ---

func TestStartForwardersBindsListenersAndReturnsForwarders(t *testing.T) {
	// Find two available ports
	port1 := findAvailablePort(t)
	port2 := findAvailablePort(t)

	client := NewAPIClient(CLIConfig{APIURL: "https://api.example.com", SessionCookie: "test"}, nil)
	runtime := Runtime{Stderr: io.Discard}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	forwarders, err := startForwarders(ctx, runtime, client, "ws-ABC", "localhost", 0, []int{port1, port2})
	if err != nil {
		t.Fatalf("startForwarders failed: %v", err)
	}
	defer cancel() // triggers server.Shutdown in goroutines

	if len(forwarders) != 2 {
		t.Fatalf("expected 2 forwarders, got %d", len(forwarders))
	}

	expectedURL1 := fmt.Sprintf("https://api.example.com/api/workspaces/ws-ABC/local-forward/%d", port1)
	if forwarders[0].targetURL != expectedURL1 {
		t.Fatalf("expected targetURL %q, got %q", expectedURL1, forwarders[0].targetURL)
	}
	if forwarders[0].localPort != port1 {
		t.Fatalf("expected localPort %d, got %d", port1, forwarders[0].localPort)
	}
	if forwarders[1].localPort != port2 {
		t.Fatalf("expected localPort %d, got %d", port2, forwarders[1].localPort)
	}
}

func TestStartForwardersCleanupOnPartialFailure(t *testing.T) {
	// Bind a port so startForwarders will fail on it
	port1 := findAvailablePort(t)
	blocker, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port1))
	if err != nil {
		t.Fatalf("failed to bind blocker port: %v", err)
	}
	defer blocker.Close()

	availablePort := findAvailablePort(t)

	client := NewAPIClient(CLIConfig{APIURL: "https://api.example.com", SessionCookie: "test"}, nil)
	runtime := Runtime{Stderr: io.Discard}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// First port succeeds, second port (blocked) fails — should clean up the first
	_, err = startForwarders(ctx, runtime, client, "ws-1", "127.0.0.1", 0, []int{availablePort, port1})
	if err == nil {
		t.Fatal("expected error when port is already bound")
	}
	if !strings.Contains(err.Error(), "failed to listen") {
		t.Fatalf("expected listen error, got: %v", err)
	}

	// Verify the first port was cleaned up (we can re-bind it)
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", availablePort))
	if err != nil {
		t.Fatalf("first port should have been cleaned up but is still bound: %v", err)
	}
	ln.Close()
}

func TestAcceptConnectionsProxiesWithToken(t *testing.T) {
	tokenCalls := 0
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		tokenCalls++
		return jsonResponse(`{"token":"test-forward-token","expiresAt":"2026-06-20T00:00:00Z","remotePort":3000,"mode":"http","localAuthority":"127.0.0.1:3000"}`, http.StatusOK), nil
	})

	remoteRequests := make(chan *http.Request, 1)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clone := r.Clone(r.Context())
		clone.Header = r.Header.Clone()
		remoteRequests <- clone

		if r.Header.Get("X-SAM-Forward-Token") != "test-forward-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}

		w.Header().Add("Set-Cookie", "app_one=1; Path=/")
		w.Header().Add("Set-Cookie", "app_two=2; Path=/")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("proxied-ok"))
	}))
	defer remote.Close()
	client := NewAPIClient(CLIConfig{APIURL: remote.URL, SessionCookie: "test"}, doer)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runtime := Runtime{Stderr: io.Discard}
	go acceptConnections(ctx, runtime, client, "ws-test", 3000, "127.0.0.1", port, ln, remote.URL+"/api/workspaces/ws-test/local-forward/3000")

	// Give the server a moment to start
	time.Sleep(50 * time.Millisecond)

	req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/test-path?client_query=1", port), nil)
	if err != nil {
		t.Fatalf("failed to build request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer app-token")
	req.Header.Set("Cookie", "app_session=abc")
	req.Header.Set("X-SAM-Forward-Token", "spoofed")
	req.Header.Set("X-Forwarded-Host", "evil.example.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("failed to connect to proxy: %v", err)
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatalf("failed to read response body: %v", err)
	}

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from proxy, got %d", resp.StatusCode)
	}
	if string(body) != "proxied-ok" {
		t.Fatalf("expected proxied response body, got %q", string(body))
	}
	if tokenCalls != 1 {
		t.Fatalf("expected 1 token API call, got %d", tokenCalls)
	}
	if got := resp.Header.Values("Set-Cookie"); len(got) != 2 {
		t.Fatalf("expected multiple app Set-Cookie headers to be preserved, got %v", got)
	}

	select {
	case req := <-remoteRequests:
		if got := req.Header.Get("X-SAM-Forward-Token"); got != "test-forward-token" {
			t.Fatalf("expected internal forward token, got %q", got)
		}
		if _, err := req.Cookie("sam_port_access"); err == nil {
			t.Fatal("did not expect sam_port_access cookie")
		}
		if got := req.Header.Get("Authorization"); got != "Bearer app-token" {
			t.Fatalf("expected app Authorization header to be preserved, got %q", got)
		}
		if got := req.Header.Get("Cookie"); got != "app_session=abc" {
			t.Fatalf("expected app Cookie header to be preserved, got %q", got)
		}
		if got := req.Header.Get("X-Forwarded-Host"); got != "" {
			t.Fatalf("expected spoofed X-Forwarded-Host stripped, got %q", got)
		}
		if got := req.URL.Query().Get("client_query"); got != "1" {
			t.Fatalf("expected client query to be preserved, got %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("remote server did not receive proxied request")
	}
}

func TestAcceptConnectionsPreservesEscapedPathSegments(t *testing.T) {
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(`{"token":"test-forward-token","expiresAt":"2026-06-20T00:00:00Z","remotePort":3000,"mode":"http","localAuthority":"127.0.0.1:3000"}`, http.StatusOK), nil
	})

	remoteRequestURIs := make(chan string, 1)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		remoteRequestURIs <- r.RequestURI
		w.WriteHeader(http.StatusOK)
	}))
	defer remote.Close()
	client := NewAPIClient(CLIConfig{APIURL: remote.URL, SessionCookie: "test"}, doer)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runtime := Runtime{Stderr: io.Discard}
	go acceptConnections(ctx, runtime, client, "ws-test", 3000, "127.0.0.1", port, ln, remote.URL+"/api/workspaces/ws-test/local-forward/3000")
	time.Sleep(50 * time.Millisecond)

	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/a%%2Fb/c?client_query=a%%2Fb", port))
	if err != nil {
		t.Fatalf("failed to connect to proxy: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from proxy, got %d", resp.StatusCode)
	}

	select {
	case got := <-remoteRequestURIs:
		want := "/api/workspaces/ws-test/local-forward/3000/a%2Fb/c?client_query=a%2Fb"
		if got != want {
			t.Fatalf("proxied RequestURI = %q, want %q", got, want)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("remote server did not receive proxied request")
	}
}

func TestAllowedLocalForwardHostRequiresExactAuthority(t *testing.T) {
	tests := []struct {
		name      string
		host      string
		localHost string
		want      bool
	}{
		{
			name:      "localhost listener accepts localhost authority",
			host:      "localhost:3000",
			localHost: "localhost",
			want:      true,
		},
		{
			name:      "localhost listener rejects loopback IP alias",
			host:      "127.0.0.1:3000",
			localHost: "localhost",
			want:      false,
		},
		{
			name:      "loopback IP listener accepts loopback IP authority",
			host:      "127.0.0.1:3000",
			localHost: "127.0.0.1",
			want:      true,
		},
		{
			name:      "loopback IP listener rejects localhost alias",
			host:      "localhost:3000",
			localHost: "127.0.0.1",
			want:      false,
		},
		{
			name:      "matching host with wrong port is rejected",
			host:      "localhost:3001",
			localHost: "localhost",
			want:      false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isAllowedLocalForwardHost(tt.host, tt.localHost, 3000)
			if got != tt.want {
				t.Fatalf("isAllowedLocalForwardHost(%q, %q, 3000) = %v, want %v", tt.host, tt.localHost, got, tt.want)
			}
		})
	}
}

func TestStripProxyRequestHeadersRemovesConnectionListedHeaders(t *testing.T) {
	headers := http.Header{}
	headers.Set("Authorization", "Bearer app-token")
	headers.Set("Cookie", "app_session=abc")
	headers.Set("Connection", "X-App-Hop, X-Forwarded-For")
	headers.Set("X-App-Hop", "must-strip")
	headers.Set("X-Forwarded-For", "spoofed")
	headers.Set("X-SAM-Forward-Token", "spoofed")

	stripProxyRequestHeaders(headers)

	if got := headers.Get("Authorization"); got != "Bearer app-token" {
		t.Fatalf("Authorization = %q, want app token preserved", got)
	}
	if got := headers.Get("Cookie"); got != "app_session=abc" {
		t.Fatalf("Cookie = %q, want app cookie preserved", got)
	}
	for _, name := range []string{"Connection", "X-App-Hop", "X-Forwarded-For", "X-SAM-Forward-Token"} {
		if got := headers.Get(name); got != "" {
			t.Fatalf("%s reached stripped headers: %q", name, got)
		}
	}
}

func TestAcceptConnectionsShutdownOnContextCancel(t *testing.T) {
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(`{"token":"tok","expiresAt":"2026-06-20T00:00:00Z","remotePort":3000,"mode":"http","localAuthority":"127.0.0.1:3000"}`, http.StatusOK), nil
	})
	client := NewAPIClient(CLIConfig{APIURL: "https://api.example.com", SessionCookie: "test"}, doer)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port

	ctx, cancel := context.WithCancel(context.Background())
	runtime := Runtime{Stderr: io.Discard}

	done := make(chan struct{})
	go func() {
		acceptConnections(ctx, runtime, client, "ws-test", 3000, "127.0.0.1", port, ln, fmt.Sprintf("https://api.example.com/api/workspaces/ws-test/local-forward/%d", 3000))
		close(done)
	}()

	time.Sleep(50 * time.Millisecond)

	// Cancel context — should trigger graceful shutdown
	cancel()

	select {
	case <-done:
		// acceptConnections returned — shutdown worked
	case <-time.After(5 * time.Second):
		t.Fatal("acceptConnections did not shut down within 5 seconds")
	}

	// Port should be released after shutdown
	ln2, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("port should be released after shutdown: %v", err)
	}
	ln2.Close()
}

// findAvailablePort returns a port that is currently available for binding.
func findAvailablePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to find available port: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return port
}
