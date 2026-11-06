package acp

import (
	"slices"
	"strings"
)

// sessionIdentityEnvKeys name the session the agent runs in. The server builds
// SAMEnvFallback per session, so for these keys it beats the container env
// files: /etc/sam/env is written once at provisioning and goes stale when a
// later task reuses the workspace.
var sessionIdentityEnvKeys = map[string]bool{
	"SAM_WORKSPACE_ID":    true,
	"SAM_WORKSPACE_URL":   true,
	"SAM_PROJECT_ID":      true,
	"SAM_CHAT_SESSION_ID": true,
	"SAM_TASK_ID":         true,
	"SAM_TASK_MODE":       true,
}

// SAMEnvFallback returns the SAM env this session's agent gets on top of its
// container env files (see mergeSAMEnvFallback). The server builds it per
// session, so it carries this session's identity, never the identity of the
// session that booted the node.
func (h *SessionHost) SAMEnvFallback() []string {
	return slices.Clone(h.config.SAMEnvFallback)
}

// mergeSAMEnvFallback layers the session's SAM env over the container env
// files: session identity keys replace file values, every other key only fills
// a gap.
func mergeSAMEnvFallback(envVars, fallback []string) []string {
	for _, entry := range fallback {
		key, _, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		if sessionIdentityEnvKeys[key] {
			envVars = append(removeEnvVar(envVars, key), entry)
		} else if !hasEnvVar(envVars, key) {
			envVars = append(envVars, entry)
		}
	}
	return envVars
}
