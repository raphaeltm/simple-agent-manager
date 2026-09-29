package acp

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"testing"

	"github.com/pelletier/go-toml/v2"
)

// Custom MCP headers reach four harness formats: ACP HTTP header lists (Claude Code and most
// agents), Codex config.toml, Vibe config.toml, and mcp-remote arguments for Amp. These tests
// pin each format to the one entry below, and prove secret values only ever travel where the
// bearer token already travels.

const composioAPIKey = "ak_live_composio_secret"

func composioEntry() McpServerEntry {
	return McpServerEntry{
		URL:  "https://backend.composio.dev/v3/mcp/server-1",
		Name: "composio",
		Headers: []McpHeader{
			{Name: "x-api-key", Value: composioAPIKey},
			{Name: "X-Org_Id", Value: "org-42"},
		},
	}
}

// mcpRemoteHeaderArg is the parser mcp-remote@0.1.38 applies to each `--header` argument
// (dist/chunk-65X3S4HB.js:20713). An argument it cannot parse is dropped with only a log line,
// so the header would silently never be sent.
var mcpRemoteHeaderArg = regexp.MustCompile(`^([A-Za-z0-9_-]+):\s*(.*)$`)

func TestBuildAcpMcpServers_SendsCustomHeadersAfterAuthorization(t *testing.T) {
	t.Parallel()

	entry := composioEntry()
	entry.Token = "bearer-token"

	servers := buildAcpMcpServers([]McpServerEntry{entry}, "claude-code")

	if len(servers) != 1 || servers[0].Http == nil {
		t.Fatalf("expected one HTTP server, got %#v", servers)
	}
	got := servers[0].Http.Headers
	want := []struct{ name, value string }{
		{"Authorization", "Bearer bearer-token"},
		{"x-api-key", composioAPIKey},
		{"X-Org_Id", "org-42"},
	}
	if len(got) != len(want) {
		t.Fatalf("headers = %#v, want %d entries", got, len(want))
	}
	for i, w := range want {
		if got[i].Name != w.name || got[i].Value != w.value {
			t.Errorf("header[%d] = %s: %s, want %s: %s", i, got[i].Name, got[i].Value, w.name, w.value)
		}
	}
}

func TestBuildAcpMcpServers_CustomHeadersWithoutBearerToken(t *testing.T) {
	t.Parallel()

	// Composio's shape: no bearer token, the API key travels in its own header.
	servers := buildAcpMcpServers([]McpServerEntry{composioEntry()}, "claude-code")

	wire, err := json.Marshal(servers[0])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded struct {
		Headers []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"headers"`
	}
	if err := json.Unmarshal(wire, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(decoded.Headers) != 2 {
		t.Fatalf("wire headers = %#v, want the two custom headers only", decoded.Headers)
	}
	for _, header := range decoded.Headers {
		if strings.EqualFold(header.Name, "Authorization") {
			t.Fatalf("no bearer token was set, but an Authorization header was sent: %#v", decoded.Headers)
		}
	}
	if decoded.Headers[0].Name != "x-api-key" || decoded.Headers[0].Value != composioAPIKey {
		t.Errorf("first wire header = %#v, want x-api-key", decoded.Headers[0])
	}
}

func TestBuildAmpMcpServer_HeaderValuesTravelInEnvNotArgs(t *testing.T) {
	t.Parallel()

	entry := composioEntry()
	entry.Token = "bearer-token"
	server := buildAcpMcpServers([]McpServerEntry{entry}, "amp")[0].Stdio
	if server == nil {
		t.Fatal("expected the Amp stdio bridge")
	}

	env := map[string]string{}
	for _, variable := range server.Env {
		env[variable.Name] = variable.Value
	}

	// Every --header argument must parse the way mcp-remote parses it, and its value must be
	// an ${ENV} reference that resolves to the intended secret.
	sent := map[string]string{}
	for i, arg := range server.Args {
		if arg != "--header" {
			continue
		}
		match := mcpRemoteHeaderArg.FindStringSubmatch(server.Args[i+1])
		if match == nil {
			t.Fatalf("mcp-remote would drop header argument %q", server.Args[i+1])
		}
		reference := strings.TrimSuffix(strings.TrimPrefix(match[2], "${"), "}")
		value, ok := env[reference]
		if !ok && match[1] != "Authorization" {
			t.Fatalf("header %s references %q, which is not in the bridge env", match[1], match[2])
		}
		sent[match[1]] = value
	}

	if sent["x-api-key"] != composioAPIKey || sent["X-Org_Id"] != "org-42" {
		t.Errorf("custom headers resolved to %#v", sent)
	}
	if env[ampMcpTokenEnvVar] != "bearer-token" {
		t.Errorf("bearer token env = %q, want it kept alongside the custom headers", env[ampMcpTokenEnvVar])
	}
	for _, arg := range server.Args {
		if strings.Contains(arg, composioAPIKey) || strings.Contains(arg, "org-42") {
			t.Fatalf("header value leaked into argv (visible in /proc/*/cmdline): %q", arg)
		}
	}
	if last := server.Args[len(server.Args)-1]; last != "--silent" {
		t.Errorf("last arg = %q, want --silent after every header", last)
	}
}

func TestGenerateCodexMcpConfig_RoutesCustomHeadersThroughEnv(t *testing.T) {
	t.Parallel()

	config, envVars := generateCodexMcpConfig([]McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "sam-token", Name: SamMcpServerName},
		composioEntry(),
	}, nil, "")

	var parsed struct {
		McpServers map[string]struct {
			URL               string            `toml:"url"`
			BearerTokenEnvVar string            `toml:"bearer_token_env_var"`
			EnvHTTPHeaders    map[string]string `toml:"env_http_headers"`
		} `toml:"mcp_servers"`
	}
	if err := toml.Unmarshal([]byte(config), &parsed); err != nil {
		t.Fatalf("managed Codex config is not valid TOML: %v\n%s", err, config)
	}

	composio := parsed.McpServers["composio"]
	// Built in a loop: a literal `"x-api-key": "SAM_…"` pair reads as an API key assignment
	// to secret scanners, but the values are environment variable NAMES.
	wantHeaders := map[string]string{}
	for i, name := range []string{"x-api-key", "X-Org_Id"} {
		wantHeaders[name] = fmt.Sprintf("SAM_MCP_COMPOSIO_HEADER_%d_SECRET", i)
	}
	if len(composio.EnvHTTPHeaders) != len(wantHeaders) {
		t.Fatalf("env_http_headers = %#v, want %#v", composio.EnvHTTPHeaders, wantHeaders)
	}
	for name, envVar := range wantHeaders {
		if composio.EnvHTTPHeaders[name] != envVar {
			t.Errorf("env_http_headers[%q] = %q, want %q", name, composio.EnvHTTPHeaders[name], envVar)
		}
	}
	if composio.BearerTokenEnvVar != "" {
		t.Errorf("tokenless server got bearer_token_env_var %q", composio.BearerTokenEnvVar)
	}
	if len(parsed.McpServers[SamMcpServerName].EnvHTTPHeaders) != 0 {
		t.Error("sam-mcp has no custom headers and must not get env_http_headers")
	}

	if strings.Contains(config, composioAPIKey) {
		t.Fatal("header value was written into config.toml instead of the environment")
	}
	joined := "\n" + strings.Join(envVars, "\n") + "\n"
	for _, want := range []string{
		"\nSAM_MCP_COMPOSIO_HEADER_0_SECRET=" + composioAPIKey + "\n",
		"\nSAM_MCP_COMPOSIO_HEADER_1_SECRET=org-42\n",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("env vars %v missing %q", envVars, strings.TrimSpace(want))
		}
	}
	for _, envVar := range envVars {
		if !isSecretEnvVar(envVar) {
			t.Errorf("%s would be passed through docker exec argv", strings.SplitN(envVar, "=", 2)[0])
		}
	}
}

// A "_TOKEN" suffix would make server "x"'s first header variable identical to the bearer
// variable of a server named "x-header-0", and one would overwrite the other.
func TestCodexMcpHeaderEnvVar_CannotCollideWithBearerEnvVar(t *testing.T) {
	t.Parallel()

	headerVar := codexMcpHeaderEnvVar("x", 0)
	bearerVar := codexMcpTokenEnvVar("x-header-0")
	if headerVar == bearerVar {
		t.Fatalf("header env var %q collides with bearer env var of server x-header-0", headerVar)
	}
	if !isSecretEnvVar(headerVar + "=value") {
		t.Fatalf("%s is not classified as a secret", headerVar)
	}
}

func TestGenerateVibeConfig_IncludesCustomHeaders(t *testing.T) {
	t.Parallel()

	entry := composioEntry()
	entry.Token = "bearer-token"
	config := generateVibeConfig("mistral-large", []McpServerEntry{entry})

	var parsed struct {
		McpServers []struct {
			Name    string            `toml:"name"`
			Headers map[string]string `toml:"headers"`
		} `toml:"mcp_servers"`
	}
	if err := toml.Unmarshal([]byte(config), &parsed); err != nil {
		t.Fatalf("Vibe config is not valid TOML: %v\n%s", err, config)
	}
	if len(parsed.McpServers) != 1 {
		t.Fatalf("mcp_servers = %#v, want one server", parsed.McpServers)
	}
	want := map[string]string{
		"Authorization": "Bearer bearer-token",
		"x-api-key":     composioAPIKey,
		"X-Org_Id":      "org-42",
	}
	got := parsed.McpServers[0].Headers
	if len(got) != len(want) {
		t.Fatalf("headers = %#v, want %#v", got, want)
	}
	for name, value := range want {
		if got[name] != value {
			t.Errorf("headers[%q] = %q, want %q", name, got[name], value)
		}
	}
}

// normalizeMcpServers rejects unsafe headers at the control-plane boundary; the config
// generators must still refuse to write one if it arrives by another path. The healthy
// server beside it is the liveness control: skipping must not drop everything.
func TestConfigGenerators_SkipServerWithUnsafeHeader(t *testing.T) {
	t.Parallel()

	unsafe := McpServerEntry{
		URL:     "https://evil.example/mcp",
		Name:    "evil",
		Headers: []McpHeader{{Name: "x-api-key", Value: "abc\n[mcp_servers.injected]"}},
	}
	entries := []McpServerEntry{composioEntry(), unsafe}

	codexConfig, codexEnv := generateCodexMcpConfig(entries, nil, "")
	vibeConfig := generateVibeConfig("mistral-large", entries)

	for harness, config := range map[string]string{"codex": codexConfig, "vibe": vibeConfig} {
		if strings.Contains(config, "evil.example") || strings.Contains(config, "injected") {
			t.Errorf("%s config contains the unsafe server:\n%s", harness, config)
		}
		if !strings.Contains(config, "backend.composio.dev") {
			t.Errorf("%s config dropped the safe server too:\n%s", harness, config)
		}
	}
	for _, envVar := range codexEnv {
		if strings.Contains(envVar, "injected") {
			t.Errorf("unsafe header value reached the Codex environment: %q", envVar)
		}
	}
}

func TestMcpServerEntryValidateHeaders(t *testing.T) {
	t.Parallel()

	const secret = "s3cr3t-value"
	cases := []struct {
		name    string
		token   string
		headers []McpHeader
		wantErr bool
	}{
		{"none", "", nil, false},
		{"composio api key", "", []McpHeader{{Name: "x-api-key", Value: secret}}, false},
		{"api key beside a bearer token", "tok", []McpHeader{{Name: "x-api-key", Value: secret}}, false},
		{"custom Authorization without a bearer token", "", []McpHeader{{Name: "Authorization", Value: "Basic dXNlcjpwYXNz=="}}, false},
		{"name with a colon", "", []McpHeader{{Name: "x:api", Value: secret}}, true},
		{"name with a dot", "", []McpHeader{{Name: "x.api", Value: secret}}, true},
		{"name with a space", "", []McpHeader{{Name: "x api", Value: secret}}, true},
		{"empty name", "", []McpHeader{{Name: "", Value: secret}}, true},
		{"name over 64 characters", "", []McpHeader{{Name: strings.Repeat("a", 65), Value: secret}}, true},
		{"empty value", "", []McpHeader{{Name: "x-api-key", Value: ""}}, true},
		{"value with LF", "", []McpHeader{{Name: "x-api-key", Value: secret + "\n"}}, true},
		{"value with CR", "", []McpHeader{{Name: "x-api-key", Value: secret + "\r"}}, true},
		{"value with NUL", "", []McpHeader{{Name: "x-api-key", Value: secret + "\x00"}}, true},
		{"value with DEL", "", []McpHeader{{Name: "x-api-key", Value: secret + "\x7f"}}, true},
		{"second header invalid", "", []McpHeader{{Name: "a", Value: "ok"}, {Name: "b", Value: "bad\n"}}, true},
		{"repeated name", "", []McpHeader{{Name: "x-api-key", Value: "a"}, {Name: "x-api-key", Value: secret}}, true},
		{"repeated name in another case", "", []McpHeader{{Name: "x-api-key", Value: "a"}, {Name: "X-API-Key", Value: secret}}, true},
		{"custom Authorization beside a bearer token", "tok", []McpHeader{{Name: "authorization", Value: secret}}, true},
		{"transport-managed name", "", []McpHeader{{Name: "content-length", Value: "0"}}, true},
		{"transport-managed name in another case", "", []McpHeader{{Name: "Host", Value: "evil.example"}}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			entry := McpServerEntry{URL: "https://api.example.com/mcp", Token: tc.token, Headers: tc.headers}
			err := entry.ValidateHeaders()
			if (err != nil) != tc.wantErr {
				t.Fatalf("ValidateHeaders() error = %v, wantErr %v", err, tc.wantErr)
			}
			// The error travels to the control plane and into rows any project member can
			// read, so it must never carry a header value.
			if err != nil && strings.Contains(err.Error(), secret) {
				t.Fatalf("error leaks the header value: %v", err)
			}
		})
	}
}

// A repeated key makes a TOML file unparseable, which would take every MCP server in it down,
// sam-mcp included. Each generator must drop only the offending server and still emit a file
// its harness can parse.
func TestConfigGenerators_SkipServerWhoseHeadersRepeatAKey(t *testing.T) {
	t.Parallel()

	entries := []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "sam-token", Name: SamMcpServerName},
		composioEntry(),
		{
			URL:     "https://repeat.example/mcp",
			Name:    "repeat",
			Headers: []McpHeader{{Name: "x-api-key", Value: "a"}, {Name: "X-API-KEY", Value: "b"}},
		},
		{
			URL:     "https://clash.example/mcp",
			Name:    "clash",
			Token:   "bearer",
			Headers: []McpHeader{{Name: "Authorization", Value: "Basic dXNlcjpwYXNz"}},
		},
	}

	codexConfig, _ := generateCodexMcpConfig(entries, nil, "")
	var codex struct {
		McpServers map[string]any `toml:"mcp_servers"`
	}
	if err := toml.Unmarshal([]byte(codexConfig), &codex); err != nil {
		t.Fatalf("Codex config is not valid TOML: %v\n%s", err, codexConfig)
	}
	if len(codex.McpServers) != 2 || codex.McpServers[SamMcpServerName] == nil || codex.McpServers["composio"] == nil {
		t.Fatalf("Codex mcp_servers = %v, want only sam-mcp and composio", codex.McpServers)
	}

	vibeConfig := generateVibeConfig("mistral-large", entries)
	var vibe struct {
		McpServers []struct {
			Name string `toml:"name"`
		} `toml:"mcp_servers"`
	}
	if err := toml.Unmarshal([]byte(vibeConfig), &vibe); err != nil {
		t.Fatalf("Vibe config is not valid TOML: %v\n%s", err, vibeConfig)
	}
	if len(vibe.McpServers) != 2 || vibe.McpServers[0].Name != SamMcpServerName || vibe.McpServers[1].Name != "composio" {
		t.Fatalf("Vibe mcp_servers = %#v, want only sam-mcp and composio", vibe.McpServers)
	}
}

// Vibe is the one harness that writes header values into its config file, so a value holding
// TOML's own delimiters must round-trip exactly rather than end the string early.
func TestGenerateVibeConfig_EscapesHeaderValues(t *testing.T) {
	t.Parallel()

	const value = `ak"live\x = "injected"`
	config := generateVibeConfig("mistral-large", []McpServerEntry{{
		URL:     "https://backend.composio.dev/mcp",
		Name:    "composio",
		Headers: []McpHeader{{Name: "x-api-key", Value: value}},
	}})

	var parsed struct {
		McpServers []struct {
			Headers map[string]string `toml:"headers"`
		} `toml:"mcp_servers"`
	}
	if err := toml.Unmarshal([]byte(config), &parsed); err != nil {
		t.Fatalf("Vibe config is not valid TOML: %v\n%s", err, config)
	}
	if len(parsed.McpServers) != 1 || len(parsed.McpServers[0].Headers) != 1 {
		t.Fatalf("mcp_servers = %#v, want one server with one header", parsed.McpServers)
	}
	if got := parsed.McpServers[0].Headers["x-api-key"]; got != value {
		t.Fatalf("x-api-key = %q, want %q", got, value)
	}
}
