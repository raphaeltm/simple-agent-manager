package acp

import (
	"fmt"
	"strings"
)

// SamMcpServerName is the reserved name for SAM's own MCP endpoint. The control plane always
// sends it first and always with a bearer token; Codex startup requires that token
// specifically for this entry (see session_host_startup.go).
const SamMcpServerName = "sam-mcp"

// maxMcpServerNameLen bounds a control-plane-supplied name. The control plane already
// validates the charset, but this is the boundary where a hostile value would reach TOML keys
// and environment-variable names, so it is re-checked here rather than trusted.
const maxMcpServerNameLen = 32

// ResolveMcpServerNames returns the agent-visible name for each entry, in order.
//
// This is the single source of truth for MCP server naming across every harness. It exists
// because the rule was previously implemented three times — in buildAcpMcpServers, in
// codexMcpServerName, and inline in generateVibeConfig — and the three had already drifted:
// Vibe emitted "sam-mcp-0" for a single server where the others emitted "sam-mcp".
//
// Rules, in order:
//  1. A valid entry name is used as-is. Tools are namespaced by it, so this is what makes
//     N servers distinguishable to the agent ("zapier__create_post", not "sam-mcp-1__...").
//  2. An entry with no name (an old control plane, which did not send one) falls back to the
//     legacy positional scheme so existing behaviour is preserved exactly: "sam-mcp" when it
//     is the only server, "sam-mcp-<index>" otherwise.
//  3. Duplicates and names that fail validation are suffixed/replaced positionally so the
//     returned slice is always unique. Harness config formats key servers by name; a
//     collision would silently drop a server.
func ResolveMcpServerNames(entries []McpServerEntry) []string {
	names := make([]string, len(entries))
	used := make(map[string]bool, len(entries))

	for i, entry := range entries {
		name := sanitizeMcpServerName(entry.Name)
		// `sam-mcp` is reserved for SAM's own endpoint, which the control plane always places
		// at index 0. Enforce that here rather than trusting the caller: this is the last
		// point before the name becomes a TOML key and an ACP server identity, and the
		// payload arrives over the wire alongside third-party entries. Without this, an entry
		// at any index claiming the reserved name would take it and silently rename SAM's own
		// endpoint to `sam-mcp-1` — letting a third party occupy the namespace the agent
		// trusts for SAM's tools (rule 51: decide from values the server verified).
		if name == SamMcpServerName && i != 0 {
			name = ""
		}
		if name == "" {
			name = legacyMcpServerName(i, len(entries))
		}
		if used[name] {
			name = uniquifyMcpServerName(name, i, used)
		}
		used[name] = true
		names[i] = name
	}
	return names
}

// legacyMcpServerName reproduces the pre-naming behaviour for unnamed entries.
func legacyMcpServerName(index, total int) string {
	if total > 1 {
		return fmt.Sprintf("%s-%d", SamMcpServerName, index)
	}
	return SamMcpServerName
}

func uniquifyMcpServerName(name string, index int, used map[string]bool) string {
	candidate := fmt.Sprintf("%s-%d", name, index)
	for used[candidate] {
		candidate += "x"
	}
	return candidate
}

// sanitizeMcpServerName returns the name if it is safe to use as a TOML bare key, an ACP
// server name and an environment-variable name component; otherwise "".
//
// Accepts lowercase alphanumerics and hyphens, not starting or ending with a hyphen. This
// mirrors MCP_CONNECTION_NAME_PATTERN in packages/shared/src/types/mcp-connection.ts — keep
// the two in sync.
func sanitizeMcpServerName(raw string) string {
	name := strings.TrimSpace(strings.ToLower(raw))
	if name == "" || len(name) > maxMcpServerNameLen {
		return ""
	}
	if strings.HasPrefix(name, "-") || strings.HasSuffix(name, "-") {
		return ""
	}
	for _, r := range name {
		isLower := r >= 'a' && r <= 'z'
		isDigit := r >= '0' && r <= '9'
		if !isLower && !isDigit && r != '-' {
			return ""
		}
	}
	return name
}

// McpServerEnvVarSuffix converts a resolved server name into an uppercase env-var component.
//
// Callers must keep a "_TOKEN" suffix on the final variable name: isSecretEnvVar in
// process.go classifies secrets by the "_TOKEN"/"_KEY"/"_SECRET" substrings, and a value that
// is not classified secret is passed through docker exec argv where it is visible in
// /proc/*/cmdline.
func McpServerEnvVarSuffix(name string) string {
	return strings.ToUpper(strings.ReplaceAll(name, "-", "_"))
}
