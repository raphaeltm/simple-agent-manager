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

func removeManagedCodexMcpBlock(existing string) string {
	for {
		start := strings.Index(existing, codexManagedMcpStartMarker)
		if start == -1 {
			return existing
		}
		endRel := strings.Index(existing[start:], codexManagedMcpEndMarker)
		if endRel == -1 {
			return existing[:start]
		}
		end := start + endRel + len(codexManagedMcpEndMarker)
		if end < len(existing) && existing[end] == '\n' {
			end++
		}
		existing = existing[:start] + existing[end:]
	}
}

func mergeManagedCodexMcpConfig(existing, managed string) string {
	cleaned := removeManagedCodexMcpBlock(existing)
	managed = strings.TrimSpace(managed)
	managedTopLevelKeys := codexTopLevelAssignmentKeys(managed)
	if len(managedTopLevelKeys) > 0 {
		lines := strings.Split(cleaned, "\n")
		filtered := lines[:0]
		atTopLevel := true
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "[") {
				atTopLevel = false
			}
			if atTopLevel {
				if key, ok := codexAssignmentKey(trimmed); ok && managedTopLevelKeys[key] {
					continue
				}
			}
			filtered = append(filtered, line)
		}
		cleaned = strings.Join(filtered, "\n")
	}
	cleaned = strings.TrimRight(cleaned, "\n")

	switch {
	case cleaned == "" && managed == "":
		return ""
	case cleaned == "":
		return managed + "\n"
	case managed == "":
		return cleaned + "\n"
	default:
		lines := strings.Split(cleaned, "\n")
		firstTable := len(lines)
		for i, line := range lines {
			if strings.HasPrefix(strings.TrimSpace(line), "[") {
				firstTable = i
				break
			}
		}
		topLevel := strings.TrimSpace(strings.Join(lines[:firstTable], "\n"))
		tables := strings.TrimSpace(strings.Join(lines[firstTable:], "\n"))
		sections := make([]string, 0, 3)
		if topLevel != "" {
			sections = append(sections, topLevel)
		}
		sections = append(sections, managed)
		if tables != "" {
			sections = append(sections, tables)
		}
		return strings.Join(sections, "\n\n") + "\n"
	}
}

func codexTopLevelAssignmentKeys(config string) map[string]bool {
	keys := make(map[string]bool)
	for _, line := range strings.Split(config, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			break
		}
		if key, ok := codexAssignmentKey(trimmed); ok {
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
