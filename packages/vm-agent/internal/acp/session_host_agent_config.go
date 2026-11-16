package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"path"
	"strings"
)

// Per-agent startup configuration written before an agent process starts: the Codex
// CODEX_CONFIG thread overrides and config.toml, and the OpenCode and Mistral Vibe config files.

const codexACPManagedAgentModeEnv = "INITIAL_AGENT_MODE=agent-full-access"
const codexACPManagedCodexPathEnv = "CODEX_PATH=codex"

// codexProjectTrust is one entry of Codex's `projects` table.
type codexProjectTrust struct {
	TrustLevel string `json:"trust_level"`
}

// codexACPManagedConfig is the CODEX_CONFIG JSON codex-acp passes to every app-server thread
// as per-thread config overrides (codex rust-v0.160.0, app-server config_manager.rs).
type codexACPManagedConfig struct {
	SandboxMode    string `json:"sandbox_mode"`
	ApprovalPolicy string `json:"approval_policy"`
	Model          string `json:"model,omitempty"`
	// BypassHookTrust and Projects let a repository's own Codex hooks run, as Claude Code
	// runs a repository's .claude/settings.json hooks. Codex loads the project .codex/ layer
	// only for a trusted project, and runs a non-managed hook only once its definition is
	// trusted by hash, which normally takes an interactive /hooks review that a SAM session
	// cannot give. The hooks come from the repository the user (or their agent) chose, and
	// they can do nothing the agent cannot already do in this full-access workspace.
	// Decision: Raphaël, 2026-11-16 (SAM idea 01M7J0TXAHGRY8CWA7Y7SJZAK0).
	//
	// Scope, stated so nobody mistakes it for "hooks only": trusting the project loads its
	// whole .codex/ layer (config.toml, including MCP servers and features, and exec-policy
	// rules), and bypass_hook_trust also runs user-level (~/.codex) hooks. Codex strips
	// provider and base-URL keys from project config, and this JSON is the highest config
	// layer, so the sandbox, approval and model settings above still win.
	BypassHookTrust bool                         `json:"bypass_hook_trust"`
	Projects        map[string]codexProjectTrust `json:"projects,omitempty"`
}

// buildCodexACPManagedConfigEnv renders CODEX_CONFIG. workDir is the session's working
// directory (the repository checkout). It is used verbatim: it is the exact string sent as
// the ACP session cwd (session_host_handshake.go), which Codex looks up project trust by.
func buildCodexACPManagedConfigEnv(settings *agentSettingsPayload, workDir string) (string, error) {
	config := codexACPManagedConfig{
		SandboxMode:     "danger-full-access",
		ApprovalPolicy:  "never",
		BypassHookTrust: true,
	}
	if settings != nil {
		config.Model = settings.Model
	}
	// "/" would trust whatever runs at the filesystem root; no SAM session uses it.
	if path.IsAbs(workDir) && path.Clean(workDir) != "/" {
		config.Projects = map[string]codexProjectTrust{workDir: {TrustLevel: "trusted"}}
	}

	encoded, err := json.Marshal(config)
	if err != nil {
		return "", fmt.Errorf("encode managed Codex config: %w", err)
	}
	return "CODEX_CONFIG=" + string(encoded), nil
}

func (h *SessionHost) writeAgentStartupConfig(ctx context.Context, agentType string, cred *agentCredential, startup *agentStartup) error {
	if agentType == "openai-codex" {
		if err := h.writeCodexStartupConfig(ctx, cred, startup); err != nil {
			return err
		}
	}
	if startup.containerID == "" {
		return nil
	}
	if agentType == "opencode" {
		h.writeOpenCodeStartupConfig(ctx, cred, startup)
	}
	if agentType == "mistral-vibe" {
		h.writeVibeStartupConfig(ctx, startup)
	}
	return nil
}

func (h *SessionHost) writeCodexStartupConfig(ctx context.Context, cred *agentCredential, startup *agentStartup) error {
	managedConfigEnv, err := buildCodexACPManagedConfigEnv(startup.settings, h.config.ContainerWorkDir)
	if err != nil {
		return fmt.Errorf("cannot start Codex: %w", err)
	}
	proxyConfig := codexProxyProviderConfigFromCredential(cred, h.callbackToken())
	effort := ""
	if startup.settings != nil {
		effort = startup.settings.Effort
	}
	// URL and CR/LF checks apply to every server: a malformed value would corrupt config.toml.
	//
	// The missing-token check applies ONLY to SAM's own endpoint. A user-configured MCP server
	// may legitimately have no bearer token — several providers issue pre-signed URLs that
	// carry the credential in the URL itself — and generateCodexMcpConfig already omits
	// bearer_token_env_var for those. Failing closed on all of them would mean one no-auth
	// connection blocks every Codex session for that user.
	mcpServers := h.mcpServers() // one snapshot: validated, written and logged together
	names := ResolveMcpServerNames(mcpServers)
	for i, server := range mcpServers {
		switch {
		case strings.TrimSpace(server.URL) == "":
			return fmt.Errorf("cannot start Codex with SAM MCP enabled: mcp server %d has a blank URL", i)
		case strings.ContainsAny(server.URL, "\r\n"):
			return fmt.Errorf("cannot start Codex with SAM MCP enabled: mcp server %d URL contains CR/LF characters", i)
		case names[i] == SamMcpServerName && strings.TrimSpace(server.Token) == "":
			return fmt.Errorf("cannot start Codex with SAM MCP enabled: mcp server %d is missing its bearer token (SAM_MCP_TOKEN)", i)
		case strings.ContainsAny(server.Token, "\r\n"):
			return fmt.Errorf("cannot start Codex with SAM MCP enabled: mcp server %d bearer token contains CR/LF characters", i)
		}
	}

	var codexMcpEnvVars []string
	if startup.containerID != "" {
		codexMcpEnvVars, err = writeCodexConfigToContainer(ctx, startup.containerID, h.config.ContainerUser, mcpServers, proxyConfig, effort)
	} else {
		codexMcpEnvVars, err = writeCodexConfigLocally(mcpServers, proxyConfig, effort)
	}
	if err != nil {
		return fmt.Errorf("cannot start Codex: write SAM MCP config.toml: %w", err)
	}
	// codex-acp (verified through 2.1.1) ignores Codex CLI -c arguments. CODEX_CONFIG is merged into
	// each app-server thread. Seed the requested model before session/new: newly
	// released Codex models may be valid provider models before they appear in the
	// adapter's default configOptions, while a configured current model is advertised
	// and can be verified by the exact post-handshake selection RPC. Every turn then
	// applies the ACP agent mode's
	// approval and sandbox policy on top. Select the wrapper's supported full-access
	// mode as well so main turns and spawned subagents cannot fall back to bwrap
	// inside SAM-managed containers. CODEX_PATH makes the adapter execute the
	// explicitly installed and version-validated companion instead of resolving a
	// potentially different nested @openai/codex dependency.
	startup.envVars = removeEnvVar(startup.envVars, "CODEX_CONFIG")
	startup.envVars = removeEnvVar(startup.envVars, "INITIAL_AGENT_MODE")
	startup.envVars = removeEnvVar(startup.envVars, "CODEX_PATH")
	startup.envVars = append(startup.envVars, managedConfigEnv)
	startup.envVars = append(startup.envVars, codexACPManagedAgentModeEnv)
	startup.envVars = append(startup.envVars, codexACPManagedCodexPathEnv)
	for _, envVar := range codexMcpEnvVars {
		key, _, ok := strings.Cut(envVar, "=")
		if ok {
			startup.envVars = removeEnvVar(startup.envVars, key)
		}
	}
	startup.envVars = append(startup.envVars, codexMcpEnvVars...)
	slog.Info("Wrote Codex config.toml",
		"mcpServers", len(mcpServers),
		"hasProxyProvider", proxyConfig != nil,
		"effort", normalizeCodexEffort(effort),
		"standalone", startup.containerID == "")
	return nil
}

func (h *SessionHost) writeOpenCodeStartupConfig(ctx context.Context, cred *agentCredential, startup *agentStartup) {
	opencodeConfig := buildOpencodeConfig(startup.settings)
	configJSON, err := json.Marshal(opencodeConfig)
	if err != nil {
		slog.Error("opencode: failed to marshal config", "error", err)
		return
	}

	startup.envVars = append(startup.envVars, "OPENCODE_CONFIG_CONTENT="+string(configJSON))
	// SAM pins its own OpenCode build (ACP live steering, opencode_install.go). Its
	// updater must never replace that binary with an upstream release mid-session.
	startup.envVars = removeEnvVar(startup.envVars, opencodeDisableAutoupdateEnvName)
	startup.envVars = append(startup.envVars, opencodeDisableAutoupdateEnvName+"=1")
	provider := DefaultOpencodeProvider
	if startup.settings != nil && startup.settings.OpencodeProvider != "" {
		provider = startup.settings.OpencodeProvider
	}
	slog.Info("OpenCode config injected",
		"provider", provider, "model", opencodeConfig["model"],
		"configLen", len(configJSON), "workspaceId", h.config.WorkspaceID)

}

func (h *SessionHost) writeVibeStartupConfig(ctx context.Context, startup *agentStartup) {
	activeModel := resolveVibeActiveModel(startup.settings)
	mcpServers := h.mcpServers()
	err := writeVibeConfigToContainer(ctx, startup.containerID, h.config.ContainerUser, activeModel, mcpServers)
	if err != nil {
		slog.Warn("Failed to write Vibe config.toml",
			"error", err, "activeModel", activeModel, "workspaceId", h.config.WorkspaceID)
		return
	}
	slog.Info("Wrote Vibe config.toml", "activeModel", activeModel, "mcpServers", len(mcpServers))
}
