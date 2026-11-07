package acp

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

const (
	codexManagedMcpStartMarker = "# BEGIN SAM MANAGED MCP"
	codexManagedMcpEndMarker   = "# END SAM MANAGED MCP"
	codexProxyProviderID       = "sam-openai"
	codexProxyProviderEnvKey   = "OPENAI_API_KEY"
)

type codexProxyProviderConfig struct {
	baseURL string
	model   string
}

// codexMcpTokenEnvVar derives the env var Codex reads a server's bearer token from.
//
// The "_TOKEN" suffix is required, not stylistic: isSecretEnvVar in process.go classifies
// secrets by that substring, and an unclassified value would be passed through docker exec
// argv and become visible in /proc/*/cmdline.
//
// The two legacy shapes ("sam-mcp" and "sam-mcp-<n>") keep their historical env var names so
// unnamed entries produce byte-identical config to before this field existed.
func codexMcpTokenEnvVar(name string) string {
	if name == SamMcpServerName {
		return "SAM_MCP_TOKEN"
	}
	if suffix, ok := strings.CutPrefix(name, SamMcpServerName+"-"); ok && isAllDigits(suffix) {
		return "SAM_MCP_TOKEN_" + suffix
	}
	return fmt.Sprintf("SAM_MCP_%s_TOKEN", McpServerEnvVarSuffix(name))
}

// codexMcpHeaderEnvVar derives the env var Codex reads a server's custom header from, via
// env_http_headers, so header values stay out of config.toml just like the bearer token.
//
// "_SECRET" rather than "_TOKEN": it must still classify as a secret for isSecretEnvVar, but a
// "_TOKEN" suffix would let server "x"'s header 0 (SAM_MCP_X_HEADER_0_TOKEN) collide with the
// bearer variable of a server named "x-header-0".
func codexMcpHeaderEnvVar(name string, index int) string {
	return fmt.Sprintf("SAM_MCP_%s_HEADER_%d_SECRET", McpServerEnvVarSuffix(name), index)
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// removeManagedCodexBlock removes every block between startMarker and endMarker. An
// unterminated block is removed through the end of the file.
func removeManagedCodexBlock(existing, startMarker, endMarker string) string {
	for {
		start := strings.Index(existing, startMarker)
		if start == -1 {
			return existing
		}
		endRel := strings.Index(existing[start:], endMarker)
		if endRel == -1 {
			return existing[:start]
		}
		end := start + endRel + len(endMarker)
		if end < len(existing) && existing[end] == '\n' {
			end++
		}
		existing = existing[:start] + existing[end:]
	}
}

// mergeManagedCodexMcpConfig replaces SAM's managed blocks in an existing config.toml:
// the MCP/sandbox block from generateCodexMcpConfig and the feature defaults planned
// by planCodexManagedFeatures. If adding the feature defaults would make the file
// invalid TOML, they are left out so Codex can still start.
func mergeManagedCodexMcpConfig(existing, managed string) string {
	cleaned := removeManagedCodexBlock(existing, codexManagedMcpStartMarker, codexManagedMcpEndMarker)
	cleaned = removeManagedCodexBlock(cleaned, codexManagedFeaturesStartMarker, codexManagedFeaturesEndMarker)
	plan := planCodexManagedFeatures(cleaned)
	if plan.placement != codexFeaturesNone {
		merged := assembleManagedCodexConfig(cleaned, managed, plan)
		err := codexConfigTOMLError(merged)
		if err == nil {
			return merged
		}
		slog.Warn("Codex config: SAM's feature defaults would make config.toml invalid; leaving Codex feature flags at their defaults",
			"error", err)
	}
	merged := assembleManagedCodexConfig(cleaned, managed, codexFeaturePlan{})
	if err := codexConfigTOMLError(merged); err != nil && codexConfigTOMLError(cleaned) == nil {
		// The user's file was valid and SAM's merge broke it, so Codex will fail to start.
		// This only makes the failure visible; the result is still written.
		slog.Error("Codex config: merged config.toml is invalid TOML although the existing file was valid",
			"error", err)
	}
	return merged
}

func codexConfigTOMLError(config string) error {
	var parsed map[string]any
	return toml.Unmarshal([]byte(config), &parsed)
}

func assembleManagedCodexConfig(cleaned, managed string, features codexFeaturePlan) string {
	if features.placement == codexFeaturesUserTable {
		cleaned = insertCodexFeaturesIntoUserTable(cleaned, features)
	}
	managed = strings.TrimSpace(managed)
	managedTopLevelKeys := codexTopLevelAssignmentKeys(managed)
	lines := strings.Split(strings.TrimRight(cleaned, "\n"), "\n")
	if len(managedTopLevelKeys) > 0 {
		starts := codexTOMLStatementStarts(lines)
		firstTable := codexTOMLFirstTableLine(lines, starts)
		filtered := make([]string, 0, len(lines))
		// Decided at each statement's first line and applied to its continuation lines,
		// so a managed key with a multi-line value is removed whole.
		dropping := false
		for i, line := range lines {
			if starts[i] {
				key, ok := codexAssignmentKey(strings.TrimSpace(codexTOMLStatementText(lines, starts, i)))
				dropping = i < firstTable && ok && managedTopLevelKeys[key]
			}
			if !dropping {
				filtered = append(filtered, line)
			}
		}
		lines = filtered
	}

	// Top-level user keys first, then SAM's block (which starts with top-level keys of
	// its own), then tables, so no top-level assignment lands inside a table.
	firstTable := codexTOMLFirstTableLine(lines, codexTOMLStatementStarts(lines))
	var beforeManaged, afterManaged string
	switch features.placement {
	case codexFeaturesTopLevelDotted:
		beforeManaged = renderCodexFeaturesBlock(features)
	case codexFeaturesOwnTable:
		afterManaged = renderCodexFeaturesBlock(features)
	}
	sections := make([]string, 0, 5)
	for _, section := range []string{
		strings.Join(lines[:firstTable], "\n"),
		beforeManaged,
		managed,
		afterManaged,
		strings.Join(lines[firstTable:], "\n"),
	} {
		if text := strings.TrimSpace(section); text != "" {
			sections = append(sections, text)
		}
	}
	if len(sections) == 0 {
		return ""
	}
	return strings.Join(sections, "\n\n") + "\n"
}

func codexTopLevelAssignmentKeys(config string) map[string]bool {
	keys := make(map[string]bool)
	lines := strings.Split(config, "\n")
	starts := codexTOMLStatementStarts(lines)
	for i := 0; i < codexTOMLFirstTableLine(lines, starts); i++ {
		if !starts[i] {
			continue
		}
		if key, ok := codexAssignmentKey(strings.TrimSpace(codexTOMLStatementText(lines, starts, i))); ok {
			keys[key] = true
		}
	}
	return keys
}

func codexAssignmentKey(line string) (string, bool) {
	if line == "" || strings.HasPrefix(line, "#") {
		return "", false
	}
	var assignment map[string]any
	if err := toml.Unmarshal([]byte(line), &assignment); err != nil || len(assignment) != 1 {
		return "", false
	}
	for key := range assignment {
		return key, true
	}
	return "", false
}

func codexProxyProviderConfigFromCredential(cred *agentCredential, callbackToken string) *codexProxyProviderConfig {
	if cred == nil || cred.inferenceConfig == nil {
		return nil
	}
	// Auth-file credentials (OAuth tokens) use auth.json injection, not env-var-based
	// proxy providers. Generating a proxy provider config here would produce a
	// config.toml entry with env_key = "OPENAI_API_KEY" that is never set,
	// causing Codex to crash immediately.
	if cred.credentialKind == "oauth-token" {
		return nil
	}
	if cred.inferenceConfig.Provider != "openai-proxy" && cred.inferenceConfig.Provider != "openai-passthrough" {
		return nil
	}
	baseURL := strings.ReplaceAll(cred.inferenceConfig.BaseURL, "{wstoken}", callbackToken)
	if baseURL == "" || strings.ContainsAny(baseURL, "\n\r") {
		return nil
	}
	model := cred.inferenceConfig.Model
	if strings.ContainsAny(model, "\n\r") {
		model = ""
	}
	return &codexProxyProviderConfig{baseURL: baseURL, model: model}
}

func generateCodexProxyProviderConfig(config *codexProxyProviderConfig) string {
	if config == nil {
		return ""
	}

	var b strings.Builder
	b.WriteString("# SAM-managed Codex provider for proxy-backed sessions.\n")
	if config.model != "" {
		b.WriteString(fmt.Sprintf("model = \"%s\"\n", tomlEscapeBasicString(config.model)))
	}
	b.WriteString(fmt.Sprintf("model_provider = \"%s\"\n\n", codexProxyProviderID))
	b.WriteString(fmt.Sprintf("[model_providers.%s]\n", codexProxyProviderID))
	b.WriteString("name = \"SAM OpenAI Proxy\"\n")
	b.WriteString(fmt.Sprintf("base_url = \"%s\"\n", tomlEscapeBasicString(config.baseURL)))
	b.WriteString(fmt.Sprintf("env_key = \"%s\"\n", codexProxyProviderEnvKey))
	b.WriteString("wire_api = \"responses\"\n\n")
	return b.String()
}

func normalizeCodexEffort(effort string) string {
	trimmed := strings.TrimSpace(effort)
	switch trimmed {
	case "low", "medium", "high", "xhigh":
		return trimmed
	default:
		return ""
	}
}

// generateCodexMcpConfig produces a managed TOML block for Codex MCP server
// configuration plus the environment variables referenced by
// bearer_token_env_var and env_http_headers. Codex natively supports streamable
// HTTP MCP servers via ~/.codex/config.toml.
func generateCodexMcpConfig(mcpServers []McpServerEntry, proxyProvider *codexProxyProviderConfig, effort string) (string, []string) {
	providerConfig := generateCodexProxyProviderConfig(proxyProvider)
	codexEffort := normalizeCodexEffort(effort)
	validServers := make([]McpServerEntry, 0, len(mcpServers))
	for i, server := range mcpServers {
		if !server.safeForConfigFile() {
			slog.Warn("Skipping Codex MCP server with control characters in its URL, token or headers",
				"index", i, "url_length", len(server.URL))
			continue
		}
		validServers = append(validServers, server)
	}
	var config strings.Builder
	envVars := make([]string, 0, len(validServers))

	config.WriteString(codexManagedMcpStartMarker)
	config.WriteString("\n# Added by SAM vm-agent for Codex ACP sessions.\n")
	config.WriteString("sandbox_mode = \"danger-full-access\"\n")
	config.WriteString("approval_policy = \"never\"\n")
	if codexEffort != "" {
		config.WriteString(fmt.Sprintf("model_reasoning_effort = \"%s\"\n", codexEffort))
	}
	config.WriteString(providerConfig)

	// Names are resolved over validServers (post-filter) so the positional fallback matches
	// the keys actually written; dropping a server renumbers the rest, which is the
	// pre-existing behaviour.
	names := ResolveMcpServerNames(validServers)
	for i, server := range validServers {
		name := names[i]
		config.WriteString(fmt.Sprintf("[mcp_servers.%s]\n", name))
		config.WriteString(fmt.Sprintf("url = \"%s\"\n", tomlEscapeBasicString(server.URL)))
		if server.Token != "" {
			tokenEnvVar := codexMcpTokenEnvVar(name)
			config.WriteString(fmt.Sprintf("bearer_token_env_var = \"%s\"\n", tokenEnvVar))
			envVars = append(envVars, fmt.Sprintf("%s=%s", tokenEnvVar, server.Token))
		}
		if len(server.Headers) > 0 {
			headerEnvVar := func(index int, _ McpHeader) string { return codexMcpHeaderEnvVar(name, index) }
			config.WriteString(fmt.Sprintf("env_http_headers = %s\n", mcpHeadersTOMLTable(server.Headers, headerEnvVar)))
			for j, header := range server.Headers {
				envVars = append(envVars, fmt.Sprintf("%s=%s", codexMcpHeaderEnvVar(name, j), header.Value))
			}
		}
		config.WriteString("\n")
	}

	config.WriteString(codexManagedMcpEndMarker)
	config.WriteString("\n")
	return config.String(), envVars
}

// writeCodexConfigToContainer updates ~/.codex/config.toml with a SAM-managed
// MCP block. Existing non-SAM config is preserved, and prior SAM-managed blocks
// are replaced so resumed or restarted sessions do not accumulate stale tokens.
func writeCodexConfigToContainer(ctx context.Context, containerID, user string, mcpServers []McpServerEntry, proxyProvider *codexProxyProviderConfig, effort string) ([]string, error) {
	managedConfig, envVars := generateCodexMcpConfig(mcpServers, proxyProvider, effort)
	existingConfig, err := readOptionalFileFromContainer(ctx, containerID, user, ".codex/config.toml")
	if err != nil {
		return nil, err
	}
	mergedConfig := mergeManagedCodexMcpConfig(existingConfig, managedConfig)
	if mergedConfig == "" {
		return nil, nil
	}
	if err := writeAuthFileToContainer(ctx, containerID, user, ".codex/config.toml", mergedConfig); err != nil {
		return nil, err
	}
	return envVars, nil
}

// writeCodexConfigLocally updates ~/.codex/config.toml on the local filesystem
// with a SAM-managed MCP block. Used for standalone/cf-container sessions where
// no Docker container is available. Mirrors writeCodexConfigToContainer.
func writeCodexConfigLocally(mcpServers []McpServerEntry, proxyProvider *codexProxyProviderConfig, effort string) ([]string, error) {
	managedConfig, envVars := generateCodexMcpConfig(mcpServers, proxyProvider, effort)

	configPath, err := resolveLocalAuthFileTargetPath(".codex/config.toml")
	if err != nil {
		return nil, fmt.Errorf("resolve codex config path: %w", err)
	}

	var existingConfig string
	data, err := os.ReadFile(configPath)
	if err == nil {
		existingConfig = string(data)
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("read existing codex config: %w", err)
	}

	mergedConfig := mergeManagedCodexMcpConfig(existingConfig, managedConfig)
	if mergedConfig == "" {
		return nil, nil
	}

	dir := filepath.Dir(configPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create codex config directory: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return nil, fmt.Errorf("chmod codex config directory: %w", err)
	}
	if err := os.WriteFile(configPath, []byte(mergedConfig), 0o600); err != nil {
		return nil, fmt.Errorf("write codex config.toml: %w", err)
	}
	if err := os.Chmod(configPath, 0o600); err != nil {
		return nil, fmt.Errorf("chmod codex config.toml: %w", err)
	}
	return envVars, nil
}
