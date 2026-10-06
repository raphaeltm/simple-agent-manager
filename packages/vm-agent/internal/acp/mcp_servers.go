package acp

import (
	"fmt"
	"strings"

	acpsdk "github.com/coder/acp-go-sdk"
)

const (
	ampMcpRemotePackage = "mcp-remote@0.1.38"
	ampMcpTokenEnvVar   = "SAM_MCP_TOKEN"
	// ampMcpHeaderEnvVarPrefix + index names the variable that carries a custom header's value
	// into the mcp-remote bridge, so values stay out of argv exactly like the token.
	ampMcpHeaderEnvVarPrefix = "SAM_MCP_HEADER_"
)

// maxMcpHeaderNameLen bounds a control-plane-supplied header name. It mirrors
// MCP_CONNECTION_HEADER_NAME_MAX_LENGTH in packages/shared/src/types/mcp-connection.ts; the two
// are pinned together by packages/shared/src/fixtures/mcp-server-name-contract.json.
const maxMcpHeaderNameLen = 64

// reservedMcpHeaderNames are set by the HTTP client or the MCP transport itself, so a custom
// value would be overwritten or would break the connection (a wrong Content-Length or Host
// corrupts request framing). Lowercase. It mirrors MCP_CONNECTION_RESERVED_HEADER_NAMES in
// packages/shared/src/types/mcp-connection.ts; mcp-server-name-contract.json pins the two.
var reservedMcpHeaderNames = map[string]bool{
	"accept":               true,
	"connection":           true,
	"content-length":       true,
	"content-type":         true,
	"host":                 true,
	"last-event-id":        true,
	"mcp-protocol-version": true,
	"mcp-session-id":       true,
	"transfer-encoding":    true,
}

// McpServerEntry is a lightweight MCP server config passed from the control
// plane for injection into ACP sessions. It represents an HTTP MCP server with
// optional bearer token authentication.
//
// An empty Token means "no auth" — several MCP providers issue pre-signed URLs
// that carry the credential in the URL itself. Every harness below omits the
// auth header in that case.
//
// Name is the agent-visible server name; tools are namespaced by it. It is
// optional because a control plane older than this field does not send one, in
// which case ResolveMcpServerNames falls back to the legacy positional scheme.
//
// Headers are custom HTTP headers sent alongside the bearer token, such as
// Composio's x-api-key. Optional for the same rollout reason as Name.
type McpServerEntry struct {
	URL     string      `json:"url"`
	Token   string      `json:"token"`
	Name    string      `json:"name,omitempty"`
	Headers []McpHeader `json:"headers,omitempty"`
}

// McpHeader is one custom HTTP header for an MCP server. Value is a secret.
type McpHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// httpHeaders returns every header the server receives, in order: the bearer token as
// Authorization, then the custom headers. Harnesses that take a literal header list use it;
// Codex and Amp route values through environment variables and build their own.
func (e McpServerEntry) httpHeaders() []McpHeader {
	headers := make([]McpHeader, 0, len(e.Headers)+1)
	if e.Token != "" {
		headers = append(headers, McpHeader{Name: "Authorization", Value: "Bearer " + e.Token})
	}
	return append(headers, e.Headers...)
}

// safeForConfigFile reports whether the entry can be written into a harness config file
// without corrupting it. normalizeMcpServers rejects unsafe entries at the control-plane
// boundary; this is the last check before a value reaches TOML.
func (e McpServerEntry) safeForConfigFile() bool {
	return !strings.ContainsAny(e.URL, "\r\n") &&
		!strings.ContainsAny(e.Token, "\r\n") &&
		e.ValidateHeaders() == nil
}

// ValidMcpHeaderName reports whether name can be written as a TOML key and passed to
// mcp-remote as `--header name:value`: 1-64 letters, digits, hyphens or underscores.
// mcp-remote silently drops any header whose name falls outside that set.
//
// This mirrors MCP_CONNECTION_HEADER_NAME_PATTERN in packages/shared/src/types/mcp-connection.ts
// — keep the two in sync. Unlike server names, header names are judged exactly as sent.
func ValidMcpHeaderName(name string) bool {
	if name == "" || len(name) > maxMcpHeaderNameLen {
		return false
	}
	for _, r := range name {
		isLetter := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
		isDigit := r >= '0' && r <= '9'
		if !isLetter && !isDigit && r != '-' && r != '_' {
			return false
		}
	}
	return true
}

// ValidMcpHeaderValue reports whether value is non-empty and free of control characters, any
// of which could split an HTTP header or a config-file line.
func ValidMcpHeaderValue(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// ValidateHeaders checks the entry's custom headers against everything that would corrupt
// what this package writes: an unusable name or value, a transport-managed name, or a name the
// server already receives — a case-insensitive duplicate, or Authorization beside a bearer
// token. A repeated key makes the whole Codex or Vibe TOML file unparseable, taking every other
// MCP server, including sam-mcp, down with it. The error never carries a value: it propagates
// to the control plane, which stores it where any project member can read it.
//
// The control plane (apps/api/src/services/mcp-connection-headers.ts) enforces the same rules
// when a connection is saved, plus the configurable count and size limits, which stay there
// alone so an operator raising them never has to redeploy the vm-agent.
func (e McpServerEntry) ValidateHeaders() error {
	seen := make(map[string]bool, len(e.Headers)+1)
	if e.Token != "" {
		seen["authorization"] = true
	}
	for i, header := range e.Headers {
		if !ValidMcpHeaderName(header.Name) {
			return fmt.Errorf("header %d has an invalid name", i)
		}
		key := strings.ToLower(header.Name)
		if reservedMcpHeaderNames[key] {
			return fmt.Errorf("header %q is set by the MCP transport and cannot be overridden", header.Name)
		}
		if seen[key] {
			return fmt.Errorf("header %q is sent more than once (repeated, or Authorization beside a bearer token)", header.Name)
		}
		seen[key] = true
		if !ValidMcpHeaderValue(header.Value) {
			return fmt.Errorf("header %q has an empty value or a control character", header.Name)
		}
	}
	return nil
}

// mcpHeadersTOMLTable renders headers as a TOML inline table, `{ "name" = "value", ... }`,
// where value decides what each header name maps to: the header value itself for Vibe, an
// environment variable name for Codex.
func mcpHeadersTOMLTable(headers []McpHeader, value func(index int, header McpHeader) string) string {
	pairs := make([]string, len(headers))
	for i, header := range headers {
		pairs[i] = fmt.Sprintf("\"%s\" = \"%s\"",
			tomlEscapeBasicString(header.Name), tomlEscapeBasicString(value(i, header)))
	}
	return "{ " + strings.Join(pairs, ", ") + " }"
}

// buildAcpMcpServers converts McpServerEntry configs into acpsdk.McpServer
// entries for NewSession/LoadSession requests.
func buildAcpMcpServers(entries []McpServerEntry, agentType string) []acpsdk.McpServer {
	if len(entries) == 0 {
		return []acpsdk.McpServer{}
	}
	servers := make([]acpsdk.McpServer, 0, len(entries))
	names := ResolveMcpServerNames(entries)
	for i, e := range entries {
		name := names[i]
		if agentType == "amp" {
			servers = append(servers, buildAmpMcpServer(name, e))
			continue
		}
		var headers []acpsdk.HttpHeader
		for _, header := range e.httpHeaders() {
			headers = append(headers, acpsdk.HttpHeader{Name: header.Name, Value: header.Value})
		}
		servers = append(servers, acpsdk.McpServer{
			Http: &acpsdk.McpServerHttpInline{
				Name: name,
				// Type is set to "http" by McpServer.MarshalJSON regardless of this field.
				Url:     e.URL,
				Headers: headers,
			},
		})
	}
	return servers
}

// KNOWN EXPOSURE (idea 01M0QQ7PTBDPG0DVR10XMKB679): entry.URL is passed as a positional CLI
// argument, so it is visible in /proc/<pid>/cmdline to anything running as the same container
// user. That is fine for SAM's own static endpoint but NOT for a bring-your-own connection,
// where the URL can itself be a credential (pre-signed MCP URLs). The token and header values
// below are already kept out of argv for exactly this reason; the URL should get the same
// treatment once it is verified how mcp-remote accepts a URL from the environment.
func buildAmpMcpServer(name string, entry McpServerEntry) acpsdk.McpServer {
	var env []acpsdk.EnvVariable
	args := []string{"-y", ampMcpRemotePackage, entry.URL}
	if entry.Token != "" {
		env = append(env, acpsdk.EnvVariable{
			Name:  ampMcpTokenEnvVar,
			Value: entry.Token,
		})
		// mcp-remote expands ${ENV_VAR} references in --header values internally.
		// The token is passed via env var (not in CLI args) to avoid /proc visibility.
		args = append(args, "--header", "Authorization:Bearer ${"+ampMcpTokenEnvVar+"}")
	}
	// Custom headers take the same route: only the header NAME reaches argv.
	for i, header := range entry.Headers {
		envVar := fmt.Sprintf("%s%d", ampMcpHeaderEnvVarPrefix, i)
		env = append(env, acpsdk.EnvVariable{Name: envVar, Value: header.Value})
		args = append(args, "--header", header.Name+":${"+envVar+"}")
	}
	args = append(args, "--silent")

	return acpsdk.McpServer{
		Stdio: &acpsdk.McpServerStdio{
			Name:    name,
			Command: "npx",
			Args:    args,
			Env:     env,
		},
	}
}
