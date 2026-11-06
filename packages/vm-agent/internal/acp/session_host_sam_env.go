package acp

import "slices"

// SAMEnvFallback returns the SAM env this session's agent gets for any key its
// container env files lack (see resolveAgentEnvVars). The server builds it per
// session, so it carries this session's identity, never the identity of the
// session that booted the node.
func (h *SessionHost) SAMEnvFallback() []string {
	return slices.Clone(h.config.SAMEnvFallback)
}
