package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	acpsdk "github.com/coder/acp-go-sdk"
)

// --- Internal: agent lifecycle (extracted from Gateway) ---

// startAgent spawns the agent process and sets up the ACP connection.
// Must hold h.mu when calling.
func (h *SessionHost) startAgent(ctx context.Context, agentType string, cred *agentCredential, settings *agentSettingsPayload, previousAcpSessionID string) error {
	return h.startAgentWithSessionMode(ctx, agentType, cred, settings, previousAcpSessionID, false)
}

func (h *SessionHost) startAgentForCrashRecovery(ctx context.Context, agentType string, cred *agentCredential, settings *agentSettingsPayload, previousAcpSessionID string) error {
	return h.startAgentWithSessionMode(ctx, agentType, cred, settings, previousAcpSessionID, true)
}

func (h *SessionHost) startAgentWithSessionMode(ctx context.Context, agentType string, cred *agentCredential, settings *agentSettingsPayload, previousAcpSessionID string, requireLoadSession bool) error {
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

	return h.establishACPSession(ctx, agentType, startup.settings, previousAcpSessionID, requireLoadSession)
}

type agentStartup struct {
	containerID  string
	info         agentCommandInfo
	envVars      []string
	secretEnvKey map[string]bool
	settings     *agentSettingsPayload
}

func (h *SessionHost) prepareAgentStartup(ctx context.Context, agentType string, cred *agentCredential, settings *agentSettingsPayload) (*agentStartup, error) {
	var containerID string
	var err error
	if h.config.ContainerResolver != nil {
		containerID, err = h.config.ContainerResolver()
		if err != nil {
			return nil, fmt.Errorf("failed to discover devcontainer: %w", err)
		}
	}

	info := getAgentCommandInfo(agentType, cred.credentialKind)
	envVars := h.resolveAgentEnvVars(ctx, containerID)
	secretEnvKeys := make(map[string]bool)
	envVars, err = h.applyRuntimeAssets(ctx, containerID, envVars, secretEnvKeys)
	if err != nil {
		return nil, err
	}
	h.trackCredentialInjection(info, cred)

	envVars, settings, err = h.injectAgentCredential(ctx, containerID, agentType, cred, settings, info, envVars)
	if err != nil {
		return nil, err
	}
	envVars, settings = h.applyModelAndExtraEnv(agentType, settings, envVars)
	h.applyPermissionMode(settings)

	return &agentStartup{
		containerID:  containerID,
		info:         info,
		envVars:      envVars,
		secretEnvKey: secretEnvKeys,
		settings:     settings,
	}, nil
}

func (h *SessionHost) applyRuntimeAssets(ctx context.Context, containerID string, envVars []string, secretEnvKeys map[string]bool) ([]string, error) {
	if h.config.RuntimeAssetsProvider == nil {
		return envVars, nil
	}
	assets, err := h.config.RuntimeAssetsProvider(ctx)
	if err != nil {
		return envVars, fmt.Errorf("failed to fetch runtime assets: %w", err)
	}
	if containerID == "" {
		if err := applyStandaloneRuntimeFiles(h.config.ContainerWorkDir, assets.Files); err != nil {
			return envVars, fmt.Errorf("failed to apply runtime files: %w", err)
		}
	} else if len(assets.Files) > 0 {
		return envVars, fmt.Errorf("runtime file provider is only supported for standalone sessions")
	}
	envVars, err = appendRuntimeEnvVars(envVars, secretEnvKeys, assets.EnvVars)
	if err != nil {
		return envVars, err
	}
	return envVars, nil
}

func (h *SessionHost) resolveAgentEnvVars(ctx context.Context, containerID string) []string {
	var envVars []string
	if containerID != "" {
		envVars = ReadContainerEnvFiles(ctx, containerID)
	}
	for _, fallback := range h.config.SAMEnvFallback {
		key, _, ok := strings.Cut(fallback, "=")
		if ok && !hasEnvVar(envVars, key) {
			envVars = append(envVars, fallback)
		}
	}

	if h.config.GitTokenFetcher != nil {
		envVars = removeEnvVar(envVars, "GH_TOKEN")
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

func removeEnvVar(envVars []string, key string) []string {
	prefix := key + "="
	filtered := envVars[:0]
	for _, entry := range envVars {
		if !strings.HasPrefix(entry, prefix) {
			filtered = append(filtered, entry)
		}
	}
	return filtered
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
		return append(envVars, fmt.Sprintf("%s=%s", credentialEnvVarName(agentType, settings, info), cred.credential)), settings, nil
	}

	switch cred.inferenceConfig.APIKeySource {
	case "user-credential":
		return h.injectPassthroughProxyCredential(agentType, cred, settings, envVars)
	case "callback-token":
		return h.injectPlatformProxyCredential(agentType, cred, settings, envVars)
	default:
		return append(envVars, fmt.Sprintf("%s=%s", credentialEnvVarName(agentType, settings, info), cred.credential)), settings, nil
	}
}

func credentialEnvVarName(agentType string, settings *agentSettingsPayload, info agentCommandInfo) string {
	if agentType != "opencode" || settings == nil {
		return info.envVarName
	}
	switch settings.OpencodeProvider {
	case "opencode-zen", "opencode-go", "custom":
		return "OPENCODE_API_KEY"
	default:
		return info.envVarName
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
	if containerID == "" {
		path, err := resolveLocalAuthFileTargetPath(info.authFilePath)
		if err != nil {
			return envVars, fmt.Errorf("resolve local auth file target path: %w", err)
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return envVars, fmt.Errorf("failed to create auth file directory: %w", err)
		}
		if err := os.Chmod(filepath.Dir(path), 0o700); err != nil {
			return envVars, fmt.Errorf("failed to chmod auth file directory: %w", err)
		}
		if err := os.WriteFile(path, []byte(cred.credential), 0o600); err != nil {
			return envVars, fmt.Errorf("failed to write auth file: %w", err)
		}
		envVars = append(envVars, "NO_BROWSER=1")
		slog.Info("Injected auth file locally", "path", path)
		if refreshEnv, ok := h.codexRefreshProxyEnv(agentType, cred); ok {
			envVars = append(envVars, refreshEnv)
		}
		return envVars, nil
	}
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

// resolveLocalAuthFileTargetPath resolves file-style agent credentials for
// standalone/cf-container sessions. The authFilePath contract is the same as
// writeAuthFileToContainer: paths are relative to the runtime user home
// directory, except Codex paths under .codex honor CODEX_HOME when present.
func resolveLocalAuthFileTargetPath(authFilePath string) (string, error) {
	if err := validateAuthFilePath(authFilePath); err != nil {
		return "", err
	}
	if strings.HasPrefix(authFilePath, ".codex/") || authFilePath == ".codex" {
		if codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME")); codexHome != "" {
			rel := strings.TrimPrefix(authFilePath, ".codex/")
			if rel == ".codex" {
				rel = ""
			}
			return filepath.Join(codexHome, filepath.FromSlash(rel)), nil
		}
	}

	homeDir, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(homeDir) == "" {
		if fallback := strings.TrimSpace(os.Getenv("HOME")); fallback != "" {
			homeDir = fallback
		} else if err != nil {
			return "", fmt.Errorf("resolve user home dir: %w", err)
		} else {
			return "", fmt.Errorf("resolve user home dir: empty HOME")
		}
	}
	return filepath.Join(homeDir, filepath.FromSlash(authFilePath)), nil
}

func (h *SessionHost) injectPassthroughProxyCredential(
	agentType string,
	cred *agentCredential,
	settings *agentSettingsPayload,
	envVars []string,
) ([]string, *agentSettingsPayload, error) {
	return h.injectProxyCredential(agentType, cred, settings, envVars, "passthrough proxy", cred.credential, "credentialLen")
}

func (h *SessionHost) injectPlatformProxyCredential(
	agentType string,
	cred *agentCredential,
	settings *agentSettingsPayload,
	envVars []string,
) ([]string, *agentSettingsPayload, error) {
	return h.injectProxyCredential(agentType, cred, settings, envVars, "platform AI proxy", h.config.CallbackToken, "callbackTokenLen")
}

// injectProxyCredential is the shared implementation behind the passthrough and
// platform proxy credential injectors. They differ only in the label used for
// diagnostics, the credential value forwarded to the agent env, and the log
// field name that records the credential length.
func (h *SessionHost) injectProxyCredential(
	agentType string,
	cred *agentCredential,
	settings *agentSettingsPayload,
	envVars []string,
	label string,
	credential string,
	credLenKey string,
) ([]string, *agentSettingsPayload, error) {
	if h.config.CallbackToken == "" {
		return envVars, settings, fmt.Errorf("%s configured but CallbackToken is empty for workspace %s", label, h.config.WorkspaceID)
	}

	baseURL := h.proxyBaseURL(cred)
	descriptor, ok := proxyEnvDescriptorFor(agentType, cred.inferenceConfig.Provider)
	if !ok {
		return envVars, settings, fmt.Errorf("%s not supported for agent %q provider %q in workspace %s", label, agentType, cred.inferenceConfig.Provider, h.config.WorkspaceID)
	}
	envVars = appendProxyEnv(envVars, descriptor, baseURL, credential, cred.inferenceConfig.Model)
	slog.Info("Proxy credential injected",
		"label", label, "agentType", agentType, "provider", cred.inferenceConfig.Provider,
		"hasBaseURL", baseURL != "", "model", cred.inferenceConfig.Model,
		credLenKey, len(credential), "workspaceId", h.config.WorkspaceID)
	return envVars, settings, nil
}

func (h *SessionHost) proxyBaseURL(cred *agentCredential) string {
	if cred == nil || cred.inferenceConfig == nil {
		return ""
	}
	return strings.ReplaceAll(cred.inferenceConfig.BaseURL, "{wstoken}", h.config.CallbackToken)
}

type proxyEnvDescriptor struct {
	baseURLEnv    string
	credentialEnv string
	modelEnv      string
}

var proxyEnvDescriptors = map[string]proxyEnvDescriptor{
	proxyEnvDescriptorKey("claude-code", "anthropic-passthrough"): {
		baseURLEnv:    "ANTHROPIC_BASE_URL",
		credentialEnv: "ANTHROPIC_API_KEY",
		modelEnv:      "ANTHROPIC_MODEL",
	},
	proxyEnvDescriptorKey("claude-code", "anthropic-proxy"): {
		baseURLEnv:    "ANTHROPIC_BASE_URL",
		credentialEnv: "ANTHROPIC_AUTH_TOKEN",
		modelEnv:      "ANTHROPIC_MODEL",
	},
	proxyEnvDescriptorKey("openai-codex", "openai-passthrough"): {
		baseURLEnv:    "OPENAI_BASE_URL",
		credentialEnv: "OPENAI_API_KEY",
		modelEnv:      "OPENAI_MODEL",
	},
	proxyEnvDescriptorKey("openai-codex", "openai-proxy"): {
		baseURLEnv:    "OPENAI_BASE_URL",
		credentialEnv: "OPENAI_API_KEY",
		modelEnv:      "OPENAI_MODEL",
	},
}

func proxyEnvDescriptorKey(agentType, provider string) string {
	return agentType + "\x00" + provider
}

func proxyEnvDescriptorFor(agentType, provider string) (proxyEnvDescriptor, bool) {
	descriptor, ok := proxyEnvDescriptors[proxyEnvDescriptorKey(agentType, provider)]
	return descriptor, ok
}

func appendProxyEnv(envVars []string, descriptor proxyEnvDescriptor, baseURL, credential, model string) []string {
	envVars = append(envVars, descriptor.baseURLEnv+"="+baseURL, descriptor.credentialEnv+"="+credential)
	if model != "" {
		envVars = append(envVars, descriptor.modelEnv+"="+model)
	}
	return envVars
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
	if agentType == "claude-code" && settings != nil {
		if effort := normalizeAgentEffort(settings.Effort); effort != "" {
			envVars = append(envVars, fmt.Sprintf("CLAUDE_CODE_EFFORT_LEVEL=%s", effort))
			slog.Info("Claude Code effort override", "effort", effort)
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
	if startup.containerID == "" {
		return nil
	}
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
	effort := ""
	if startup.settings != nil {
		effort = startup.settings.Effort
	}
	codexMcpEnvVars, err := writeCodexConfigToContainer(ctx, startup.containerID, h.config.ContainerUser, h.config.McpServers, proxyConfig, effort)
	if err != nil {
		slog.Warn("Failed to write Codex config.toml", "error", err, "workspaceId", h.config.WorkspaceID)
		return
	}
	startup.envVars = append(startup.envVars, codexMcpEnvVars...)
	slog.Info("Wrote Codex config.toml", "mcpServers", len(h.config.McpServers), "hasProxyProvider", proxyConfig != nil, "effort", normalizeCodexEffort(effort))
}

func (h *SessionHost) writeOpenCodeStartupConfig(ctx context.Context, cred *agentCredential, startup *agentStartup) {
	opencodeConfig := buildOpencodeConfig(startup.settings)
	configJSON, err := json.Marshal(opencodeConfig)
	if err != nil {
		slog.Error("opencode: failed to marshal config", "error", err)
		return
	}

	startup.envVars = append(startup.envVars, "OPENCODE_CONFIG_CONTENT="+string(configJSON))
	provider := DefaultOpencodeProvider
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

func (h *SessionHost) startAgentProcess(startup *agentStartup) (agentProcess, error) {
	if h.config.StartProcess != nil {
		return h.config.StartProcess(startup)
	}
	launcher := h.config.ProcessLauncher
	if launcher == nil {
		launcher = DockerExecLauncher{}
	}
	return launcher.Start(ProcessConfig{
		ContainerID:   startup.containerID,
		ContainerUser: h.config.ContainerUser,
		AcpCommand:    startup.info.command,
		AcpArgs:       startup.info.args,
		EnvVars:       startup.envVars,
		SecretEnvKeys: startup.secretEnvKey,
		WorkDir:       h.config.ContainerWorkDir,
	})
}

func (h *SessionHost) attachACPConnection(process agentProcess) {
	processedCh := make(chan struct{}, 1)
	client := &sessionHostClient{host: h, processedCh: processedCh}

	serializeTimeout := h.config.NotifSerializeTimeout
	if serializeTimeout <= 0 {
		serializeTimeout = DefaultNotifSerializeTimeout
	}
	orderedStdout := newOrderedPipe(process.Stdout(), processedCh, h.ctx.Done(), serializeTimeout)
	h.acpConn = acpsdk.NewClientSideConnection(client, process.Stdin(), orderedStdout)
}
