package acp

import "log/slog"

// RestartAgentProcessForCredentialRotation replaces this host's running agent
// process after the workspace's callback generation was rotated by a restart or
// rebuild. The control plane revoked the previous generation before delivering
// the new token, and a running agent process keeps the credentials it was
// started with, so it must be replaced to keep working.
//
// The host itself stays registered and is never marked stopped: the
// control-plane task-liveness probe treats a stopped agent host as a dead task
// (task_agent_host_stopped), so stopping it fails a live chat. Instead the
// current process is terminated through the same intentional-stop mechanism a
// prompt cancel uses, and the process monitor (monitorProcessExit) restarts the
// agent in place, LoadSession-resuming the same conversation, without counting
// a crash.
//
// The replacement process starts with the current credentials because every
// agent (re)start reads them at start time, not from host construction:
//   - the callback token through h.callbackToken() (updated by SetCallbackToken):
//     the platform AI proxy key and base URL (injectPlatformProxyCredential,
//     proxyBaseURL), the Codex refresh proxy URL (codexRefreshProxyEnv) and the
//     Codex proxy provider config (writeCodexStartupConfig), and the agent-key
//     and runtime-asset fetches;
//   - the MCP servers through h.mcpServers() (updated by SetMcpServers): the
//     NewSession/LoadSession MCP list (session_host_handshake.go) and Codex
//     config.toml (writeCodexStartupConfig).
//
// The caller must therefore install the new callback token and MCP servers
// before calling this.
//
// Returns whether an agent process was running. With none (the host is idle or
// its agent has not started) or the host was stopped, it does nothing: the next
// agent start already reads the current credentials.
func (h *SessionHost) RestartAgentProcessForCredentialRotation() bool {
	// A stopped host has already detached its process (Stop ->
	// stopCurrentAgentLocked), so it reports no running process here.
	if !h.stopProcessForIntentionalRestart("RestartAgentProcessForCredentialRotation") {
		return false
	}
	slog.Info("Restarting agent process for a workspace credential rotation",
		"workspaceId", h.config.WorkspaceID, "sessionId", h.config.SessionID)
	return true
}
