package config

import (
	"fmt"
	"strings"
)

// DeriveBaseDomain extracts the base domain from a control plane URL by stripping
// the protocol, path, port, and "api." subdomain prefix.
// Example: "https://api.example.com/foo" → "example.com"
func DeriveBaseDomain(controlPlaneURL string) string {
	host := controlPlaneURL
	host = strings.TrimPrefix(host, "https://")
	host = strings.TrimPrefix(host, "http://")

	if idx := strings.Index(host, "/"); idx != -1 {
		host = host[:idx]
	}
	if idx := strings.Index(host, ":"); idx != -1 {
		host = host[:idx]
	}
	if strings.HasPrefix(host, "api.") {
		return host[4:]
	}
	return host
}

// BuildSAMEnvFallback returns KEY=value pairs for SAM environment variables
// derived from the vm-agent config. Used as fallback injection into ACP sessions
// when the bootstrap-written /etc/sam/env file is missing or incomplete.
func (c *Config) BuildSAMEnvFallback() []string {
	baseDomain := DeriveBaseDomain(c.ControlPlaneURL)

	type entry struct{ key, value string }
	entries := []entry{
		{"SAM_API_URL", strings.TrimRight(c.ControlPlaneURL, "/")},
		{"SAM_BRANCH", c.Branch},
		{"SAM_NODE_ID", c.NodeID},
		{"SAM_PROJECT_ID", c.ProjectID},
		{"SAM_CHAT_SESSION_ID", c.ChatSessionID},
		{"SAM_TASK_ID", c.TaskID},
		{"SAM_TASK_MODE", c.TaskMode},
		{"SAM_REPOSITORY", c.Repository},
		{"SAM_WORKSPACE_ID", c.WorkspaceID},
	}
	if baseDomain != "" {
		entries = append(entries, entry{"SAM_BASE_DOMAIN", baseDomain})
		if c.WorkspaceID != "" {
			entries = append(entries, entry{"SAM_WORKSPACE_URL", fmt.Sprintf("https://ws-%s.%s", c.WorkspaceID, baseDomain)})
		}
	}

	var result []string
	for _, e := range entries {
		if e.value != "" {
			result = append(result, e.key+"="+e.value)
		}
	}
	return result
}

// deriveAllowedOrigins extracts allowed origins from the control plane URL.
// This allows the control plane domain and workspace subdomains.
func deriveAllowedOrigins(controlPlaneURL string) []string {
	baseDomain := DeriveBaseDomain(controlPlaneURL)
	return []string{
		controlPlaneURL,
		"https://*." + baseDomain, // Allow workspace subdomains
	}
}
