package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"strings"

	acpsdk "github.com/coder/acp-go-sdk"
)

// --- Internal: agent lifecycle (extracted from Gateway) ---

// startAgent spawns the agent process and sets up the ACP connection.
// Must hold h.mu when calling.
func (h *SessionHost) startAgent(ctx context.Context, agentType string, cred *agentCredential, settings *agentSettingsPayload, previousAcpSessionID string) error {
	startup, err := h.prepareAgentStartup(ctx, agentType, cred, settings)
	if err != nil {
		return err
	}
	if err := h.writeAgentStartupConfig(ctx, agentType, cred, startup); err != nil {
		return err
	}

	process, err := h.startAgentProcess(startup)
	if err != nil {
		return fmt.Errorf("failed to start agent process: %w", err)
	}

	h.process = process
	h.attachACPConnection(process)
	go h.monitorStderr(process)
	go h.monitorProcessExit(ctx, process, agentType, cred, startup.settings)

	return h.establishACPSession(ctx, agentType, startup.settings, previousAcpSessionID)
}

type agentStartup struct {
	containerID string
	info        agentCommandInfo
	envVars     []string
	settings    *agentSettingsPayload
}

func (h *SessionHost) prepareAgentStartup(ctx context.Context, agentType string, cred *agentCredential, settings *agentSettingsPayload) (*agentStartup, error) {
	containerID, err := h.config.ContainerResolver()
	if err != nil {
		return nil, fmt.Errorf("failed to discover devcontainer: %w", err)
	}

	info := getAgentCommandInfo(agentType, cred.credentialKind)
	envVars := h.resolveAgentEnvVars(ctx, containerID)
	h.trackCredentialInjection(info, cred)

	envVars, settings, err = h.injectAgentCredential(ctx, containerID, agentType, cred, settings, info, envVars)
	if err != nil {
		return nil, err
	}
	envVars, settings = h.applyModelAndExtraEnv(agentType, settings, envVars)
	h.applyPermissionMode(settings)

	return &agentStartup{
		containerID: containerID,
		info:        info,
		envVars:     envVars,
		settings:    settings,
	}, nil
}

func (h *SessionHost) resolveAgentEnvVars(ctx context.Context, containerID string) []string {
	envVars := ReadContainerEnvFiles(ctx, containerID)
	for _, fallback := range h.config.SAMEnvFallback {
		key, _, ok := strings.Cut(fallback, "=")
		if ok && !hasEnvVar(envVars, key) {
			envVars = append(envVars, fallback)
		}
	}

	if h.config.GitTokenFetcher != nil && !hasEnvVar(envVars, "GH_TOKEN") {
		if token, err := h.config.GitTokenFetcher(ctx); err == nil && token != "" {
			envVars = append(envVars, "GH_TOKEN="+token)
			slog.Info("Injected GH_TOKEN via runtime fetch", "workspaceId", h.config.WorkspaceID)
		} else if err != nil {
			slog.Warn("Failed to fetch GH_TOKEN for ACP session — agent will run without GitHub access",
				"workspaceId", h.config.WorkspaceID, "sessionId", h.config.SessionID, "error", err)
		}
	}
	return envVars
}

func (h *SessionHost) trackCredentialInjection(info agentCommandInfo, cred *agentCredential) {
	h.credInjectionMode = info.injectionMode
	h.credAuthFilePath = info.authFilePath
	h.credKind = cred.credentialKind
}

func (h *SessionHost) injectAgentCredential(
	ctx context.Context,
	containerID string,
	agentType string,
	cred *agentCredential,
	settings *agentSettingsPayload,
	info agentCommandInfo,
	envVars []string,
) ([]string, *agentSettingsPayload, error) {
	if info.injectionMode == "auth-file" {
		envVars, err := h.injectAuthFileCredential(ctx, containerID, agentType, cred, info, envVars)
		return envVars, settings, err
	}
	if cred.inferenceConfig == nil {
		return append(envVars, fmt.Sprintf("%s=%s", info.envVarName, cred.credential)), settings, nil
	}

	switch cred.inferenceConfig.APIKeySource {
	case "user-credential":
		return h.injectPassthroughProxyCredential(agentType, cred, settings, envVars)
	case "callback-token":
		return h.injectPlatformProxyCredential(agentType, cred, settings, envVars)
	default:
		return append(envVars, fmt.Sprintf("%s=%s", info.envVarName, cred.credential)), settings, nil
	}
}

func (h *SessionHost) injectAuthFileCredential(
	ctx context.Context,
	containerID string,
	agentType string,
	cred *agentCredential,
	info agentCommandInfo,
	envVars []string,
) ([]string, error) {
	if err := writeAuthFileToContainer(ctx, containerID, h.config.ContainerUser, info.authFilePath, cred.credential); err != nil {
		return envVars, fmt.Errorf("failed to write auth file: %w", err)
	}
	envVars = append(envVars, "NO_BROWSER=1")
	slog.Info("Injected auth file into container", "path", info.authFilePath)

	if refreshEnv, ok := h.codexRefreshProxyEnv(agentType, cred); ok {
		envVars = append(envVars, refreshEnv)
		slog.Info("Injected Codex refresh proxy URL",
			"workspaceId", h.config.WorkspaceID,
			"sessionId", h.config.SessionID,
			"credentialKind", cred.credentialKind)
	}
	return envVars, nil
}

func (h *SessionHost) codexRefreshProxyEnv(agentType string, cred *agentCredential) (string, bool) {
	if agentType != "openai-codex" || cred.credentialKind != "oauth-token" ||
		h.config.ControlPlaneURL == "" || h.config.CallbackToken == "" {
		return "", false
	}
	u, err := url.Parse(strings.TrimSuffix(h.config.ControlPlaneURL, "/") + "/api/auth/codex-refresh")
	if err != nil {
		slog.Warn("Invalid ControlPlaneURL for Codex refresh proxy",
			"error", err, "workspaceId", h.config.WorkspaceID)
		return "", false
	}
	q := url.Values{}
	q.Set("token", h.config.CallbackToken)
	u.RawQuery = q.Encode()
	return "CODEX_REFRESH_TOKEN_URL_OVERRIDE=" + u.String(), true
}

func (h *SessionHost) injectPassthroughProxyCredential(
	agentType string,
	cred *agentCredential,
	settings *agentSettingsPayload,
	envVars []string,
) ([]string, *agentSettingsPayload, error) {
	if h.config.CallbackToken == "" {
		return envVars, settings, fmt.Errorf("passthrough proxy configured but CallbackToken is empty for workspace %s", h.config.WorkspaceID)
	}

	baseURL := strings.ReplaceAll(cred.inferenceConfig.BaseURL, "{wstoken}", h.config.CallbackToken)
	if agentType == "claude-code" && cred.inferenceConfig.Provider == "anthropic-passthrough" {
		envVars = appendAnthropicProxyEnv(envVars, baseURL, cred.credential, cred.inferenceConfig.Model, "ANTHROPIC_API_KEY")
		slog.Info("Claude Code passthrough proxy credential injected",
			"hasBaseURL", baseURL != "", "model", cred.inferenceConfig.Model,
			"credentialLen", len(cred.credential), "workspaceId", h.config.WorkspaceID)
		return envVars, settings, nil
	}
	if agentType == "openai-codex" && cred.inferenceConfig.Provider == "openai-passthrough" {
		envVars = appendOpenAIProxyEnv(envVars, baseURL, cred.credential, cred.inferenceConfig.Model)
		slog.Info("Codex passthrough proxy credential injected",
			"hasBaseURL", baseURL != "", "model", cred.inferenceConfig.Model,
			"credentialLen", len(cred.credential), "workspaceId", h.config.WorkspaceID)
		return envVars, settings, nil
	}

	envVars = append(envVars, "OPENCODE_PLATFORM_BASE_URL="+baseURL, "OPENCODE_PLATFORM_API_KEY="+cred.credential)
	settings = configureOpenCodePlatformSettings(settings, cred.inferenceConfig.Model)
	slog.Info("OpenCode passthrough proxy credential injected",
		"hasBaseURL", baseURL != "", "model", cred.inferenceConfig.Model,
		"credentialLen", len(cred.credential), "workspaceId", h.config.WorkspaceID)
	return envVars, settings, nil
}

func (h *SessionHost) injectPlatformProxyCredential(
	agentType string,
	cred *agentCredential,
	settings *agentSettingsPayload,
	envVars []string,
) ([]string, *agentSettingsPayload, error) {
	if h.config.CallbackToken == "" {
		return envVars, settings, fmt.Errorf("platform AI proxy configured but CallbackToken is empty for workspace %s", h.config.WorkspaceID)
	}

	if agentType == "claude-code" && cred.inferenceConfig.Provider == "anthropic-proxy" {
		envVars = appendAnthropicProxyEnv(envVars, cred.inferenceConfig.BaseURL, h.config.CallbackToken, cred.inferenceConfig.Model, "ANTHROPIC_AUTH_TOKEN")
		slog.Info("Claude Code AI proxy credential injected",
			"baseURL", cred.inferenceConfig.BaseURL, "model", cred.inferenceConfig.Model,
			"callbackTokenLen", len(h.config.CallbackToken), "workspaceId", h.config.WorkspaceID)
		return envVars, settings, nil
	}
	if agentType == "openai-codex" && cred.inferenceConfig.Provider == "openai-proxy" {
		envVars = appendOpenAIProxyEnv(envVars, cred.inferenceConfig.BaseURL, h.config.CallbackToken, cred.inferenceConfig.Model)
		slog.Info("Codex AI proxy credential injected",
			"baseURL", cred.inferenceConfig.BaseURL, "model", cred.inferenceConfig.Model,
			"callbackTokenLen", len(h.config.CallbackToken), "workspaceId", h.config.WorkspaceID)
		return envVars, settings, nil
	}

	envVars = append(envVars, "OPENCODE_PLATFORM_BASE_URL="+cred.inferenceConfig.BaseURL, "OPENCODE_PLATFORM_API_KEY="+h.config.CallbackToken)
	settings = configureOpenCodePlatformSettings(settings, cred.inferenceConfig.Model)
	slog.Info("OpenCode AI proxy credential injected",
		"baseURL", cred.inferenceConfig.BaseURL, "model", cred.inferenceConfig.Model,
		"settingsModel", settings.Model, "settingsProvider", settings.OpencodeProvider,
		"callbackTokenLen", len(h.config.CallbackToken), "workspaceId", h.config.WorkspaceID)
	return envVars, settings, nil
}

func appendAnthropicProxyEnv(envVars []string, baseURL, credential, model, credentialEnv string) []string {
	envVars = append(envVars, "ANTHROPIC_BASE_URL="+baseURL, credentialEnv+"="+credential)
	if model != "" {
		envVars = append(envVars, "ANTHROPIC_MODEL="+model)
	}
	return envVars
}

func appendOpenAIProxyEnv(envVars []string, baseURL, credential, model string) []string {
	envVars = append(envVars, "OPENAI_BASE_URL="+baseURL, "OPENAI_API_KEY="+credential)
	if model != "" {
		envVars = append(envVars, "OPENAI_MODEL="+model)
	}
	return envVars
}

func configureOpenCodePlatformSettings(settings *agentSettingsPayload, model string) *agentSettingsPayload {
	if settings == nil {
		settings = &agentSettingsPayload{}
	}
	settings.OpencodeProvider = "platform"
	if settings.Model == "" && model != "" {
		settings.Model = stripCFPrefix(model)
	}
	return settings
}

func (h *SessionHost) applyModelAndExtraEnv(agentType string, settings *agentSettingsPayload, envVars []string) ([]string, *agentSettingsPayload) {
	if agentType == "mistral-vibe" {
		activeModel := resolveVibeActiveModel(settings)
		envVars = append(envVars, fmt.Sprintf("VIBE_ACTIVE_MODEL=%s", activeModel))
	} else if settings != nil && settings.Model != "" {
		if modelEnv := getModelEnvVar(agentType); modelEnv != "" {
			envVars = append(envVars, fmt.Sprintf("%s=%s", modelEnv, settings.Model))
			slog.Info("Agent model override", "envVar", modelEnv, "model", settings.Model)
		}
	}
	if extraEnv := getAgentExtraEnvVars(agentType); len(extraEnv) > 0 {
		envVars = append(envVars, extraEnv...)
	}
	return envVars, settings
}

func (h *SessionHost) applyPermissionMode(settings *agentSettingsPayload) {
	if settings != nil && settings.PermissionMode != "" {
		h.permissionMode = settings.PermissionMode
	} else {
		h.permissionMode = "default"
	}
}

func (h *SessionHost) writeAgentStartupConfig(ctx context.Context, agentType string, cred *agentCredential, startup *agentStartup) error {
	if agentType == "openai-codex" {
		h.writeCodexStartupConfig(ctx, cred, startup)
	}
	if agentType == "opencode" {
		h.writeOpenCodeStartupConfig(ctx, cred, startup)
	}
	if agentType == "mistral-vibe" {
		h.writeVibeStartupConfig(ctx, startup)
	}
	return nil
}

func (h *SessionHost) writeCodexStartupConfig(ctx context.Context, cred *agentCredential, startup *agentStartup) {
	proxyConfig := codexProxyProviderConfigFromCredential(cred, h.config.CallbackToken)
	codexMcpEnvVars, err := writeCodexConfigToContainer(ctx, startup.containerID, h.config.ContainerUser, h.config.McpServers, proxyConfig)
	if err != nil {
		slog.Warn("Failed to write Codex config.toml", "error", err, "workspaceId", h.config.WorkspaceID)
		return
	}
	startup.envVars = append(startup.envVars, codexMcpEnvVars...)
	slog.Info("Wrote Codex config.toml", "mcpServers", len(h.config.McpServers), "hasProxyProvider", proxyConfig != nil)
}

func (h *SessionHost) writeOpenCodeStartupConfig(ctx context.Context, cred *agentCredential, startup *agentStartup) {
	overrides := h.opencodeConfigOverrides(cred)
	opencodeConfig := buildOpencodeConfig(startup.settings, overrides)
	configJSON, err := json.Marshal(opencodeConfig)
	if err != nil {
		slog.Error("opencode: failed to marshal config", "error", err)
		return
	}

	startup.envVars = append(startup.envVars, "OPENCODE_CONFIG_CONTENT="+string(configJSON))
	provider := "scaleway"
	if startup.settings != nil && startup.settings.OpencodeProvider != "" {
		provider = startup.settings.OpencodeProvider
	}
	slog.Info("OpenCode config injected",
		"provider", provider, "model", opencodeConfig["model"],
		"configLen", len(configJSON), "workspaceId", h.config.WorkspaceID)

	if npmPkg := opencodeProviderNeedsNpmPackage(provider); npmPkg != "" {
		if err := preInstallOpencodeProviderDeps(ctx, startup.containerID, h.config.ContainerUser, npmPkg); err != nil {
			slog.Warn("Failed to pre-install OpenCode provider dependency (agent may fail silently)",
				"package", npmPkg, "provider", provider, "error", err)
		}
	}
}

func (h *SessionHost) opencodeConfigOverrides(cred *agentCredential) *opencodeConfigOverrides {
	if cred.inferenceConfig == nil {
		return nil
	}
	switch cred.inferenceConfig.APIKeySource {
	case "callback-token":
		return &opencodeConfigOverrides{
			PlatformBaseURL: cred.inferenceConfig.BaseURL,
			PlatformAPIKey:  h.config.CallbackToken,
		}
	case "user-credential":
		return &opencodeConfigOverrides{
			PlatformBaseURL: strings.ReplaceAll(cred.inferenceConfig.BaseURL, "{wstoken}", h.config.CallbackToken),
			PlatformAPIKey:  cred.credential,
		}
	default:
		return nil
	}
}

func (h *SessionHost) writeVibeStartupConfig(ctx context.Context, startup *agentStartup) {
	activeModel := resolveVibeActiveModel(startup.settings)
	err := writeVibeConfigToContainer(ctx, startup.containerID, h.config.ContainerUser, activeModel, h.config.McpServers)
	if err != nil {
		slog.Warn("Failed to write Vibe config.toml",
			"error", err, "activeModel", activeModel, "workspaceId", h.config.WorkspaceID)
		return
	}
	slog.Info("Wrote Vibe config.toml", "activeModel", activeModel, "mcpServers", len(h.config.McpServers))
}

func (h *SessionHost) startAgentProcess(startup *agentStartup) (*AgentProcess, error) {
	return StartProcess(ProcessConfig{
		ContainerID:   startup.containerID,
		ContainerUser: h.config.ContainerUser,
		AcpCommand:    startup.info.command,
		AcpArgs:       startup.info.args,
		EnvVars:       startup.envVars,
		WorkDir:       h.config.ContainerWorkDir,
	})
}

func (h *SessionHost) attachACPConnection(process *AgentProcess) {
	processedCh := make(chan struct{}, 1)
	client := &sessionHostClient{host: h, processedCh: processedCh}

	serializeTimeout := h.config.NotifSerializeTimeout
	if serializeTimeout <= 0 {
		serializeTimeout = DefaultNotifSerializeTimeout
	}
	orderedStdout := newOrderedPipe(process.Stdout(), processedCh, h.ctx.Done(), serializeTimeout)
	h.acpConn = acpsdk.NewClientSideConnection(client, process.Stdin(), orderedStdout)
}
