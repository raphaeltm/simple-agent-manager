package acp

// mcpServers returns the MCP server configs for agent starts and ACP session
// requests: the latest list delivered through SetMcpServers, else the list the
// host was created with. Every agent (re)start, NewSession and LoadSession reads
// it here, so a replacement reaches the next start of this host's agent.
//
// Lock-free like callbackToken(): startup paths run while h.mu is held by other
// goroutines and must not wait on it.
func (h *SessionHost) mcpServers() []McpServerEntry {
	if replaced := h.replacedMcpServers.Load(); replaced != nil {
		return *replaced
	}
	return h.config.McpServers
}

// SetMcpServers replaces the MCP server configs used by this host's later agent
// starts and ACP session requests. The control plane rotates the sam-mcp token
// when it rotates the workspace callback generation; the server calls this with
// the rotated list for every live host of the workspace, then restarts each
// host's running agent process in place
// (RestartAgentProcessForCredentialRotation) so the replacement starts with the
// rotated token. An agent process that is already running keeps the
// configuration it was started with until that restart, exactly as with
// SetCallbackToken.
//
// The slice is copied, so the caller may keep mutating its own.
func (h *SessionHost) SetMcpServers(entries []McpServerEntry) {
	copied := append([]McpServerEntry(nil), entries...)
	h.replacedMcpServers.Store(&copied)
}

// UsesMcpServerToken reports whether the named MCP server's bearer token for
// this host's next agent start equals token, without exposing the token. Used
// by the server package to verify that a rotation reached every live host.
func (h *SessionHost) UsesMcpServerToken(name, token string) bool {
	for _, server := range h.mcpServers() {
		if server.Name == name {
			return token != "" && server.Token == token
		}
	}
	return false
}
