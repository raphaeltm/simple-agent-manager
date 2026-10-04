package acp

import "strings"

// callbackToken returns the workspace callback token for control-plane calls:
// the latest one delivered through SetCallbackToken, else the token the host was
// created with. Every control-plane request and every agent process start reads
// it here, so a renewal reaches activity, usage, interaction, agent-key and
// runtime-asset calls, and the credentials injected into the next agent start.
//
// Lock-free: callers include the ACP notification goroutine, which must never
// block on h.mu (see the mirror fields on SessionHost and .claude/rules/46).
func (h *SessionHost) callbackToken() string {
	if token, ok := h.renewedCallbackToken.Load().(string); ok && token != "" {
		return token
	}
	return h.config.CallbackToken
}

// SetCallbackToken replaces the workspace callback token used by this host's
// later control-plane calls. Empty tokens are ignored. An agent process that is
// already running keeps the credentials it was started with (for example the
// platform AI proxy key); it picks up the new token on its next (re)start.
func (h *SessionHost) SetCallbackToken(token string) {
	if token = strings.TrimSpace(token); token != "" {
		h.renewedCallbackToken.Store(token)
	}
}

// UsesCallbackToken reports whether this host's control-plane calls currently
// authenticate with token, without exposing the token itself. Used by the
// server package to verify that renewals reach every live host.
func (h *SessionHost) UsesCallbackToken(token string) bool {
	return token != "" && h.callbackToken() == token
}
