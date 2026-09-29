package acp

import (
	acpsdk "github.com/coder/acp-go-sdk"
)

const (
	ampMcpRemotePackage = "mcp-remote@0.1.38"
	ampMcpTokenEnvVar   = "SAM_MCP_TOKEN"
)

// McpServerEntry is a lightweight MCP server config passed from the control
// plane for injection into ACP sessions. It represents an HTTP MCP server with
// optional bearer token authentication.
//
// An empty Token means "no auth" — several MCP providers issue pre-signed URLs
// that carry the credential in the URL itself. Every harness below omits the
// auth header in that case.
//
// Name is the agent-visible server name; tools are namespaced by it. It is
// optional because a control plane older than this field does not send one, in
// which case ResolveMcpServerNames falls back to the legacy positional scheme.
type McpServerEntry struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	Name  string `json:"name,omitempty"`
}

// buildAcpMcpServers converts McpServerEntry configs into acpsdk.McpServer
// entries for NewSession/LoadSession requests.
func buildAcpMcpServers(entries []McpServerEntry, agentType string) []acpsdk.McpServer {
	if len(entries) == 0 {
		return []acpsdk.McpServer{}
	}
	servers := make([]acpsdk.McpServer, 0, len(entries))
	names := ResolveMcpServerNames(entries)
	for i, e := range entries {
		name := names[i]
		if agentType == "amp" {
			servers = append(servers, buildAmpMcpServer(name, e))
			continue
		}
		var headers []acpsdk.HttpHeader
		if e.Token != "" {
			headers = append(headers, acpsdk.HttpHeader{
				Name:  "Authorization",
				Value: "Bearer " + e.Token,
			})
		}
		servers = append(servers, acpsdk.McpServer{
			Http: &acpsdk.McpServerHttpInline{
				Name: name,
				// Type is set to "http" by McpServer.MarshalJSON regardless of this field.
				Url:     e.URL,
				Headers: headers,
			},
		})
	}
	return servers
}

// KNOWN EXPOSURE (idea 01M0QQ7PTBDPG0DVR10XMKB679): entry.URL is passed as a positional CLI
// argument, so it is visible in /proc/<pid>/cmdline to anything running as the same container
// user. That is fine for SAM's own static endpoint but NOT for a bring-your-own connection,
// where the URL can itself be a credential (pre-signed MCP URLs). The token below is already
// kept out of argv for exactly this reason; the URL should get the same treatment once it is
// verified how mcp-remote accepts a URL from the environment.
func buildAmpMcpServer(name string, entry McpServerEntry) acpsdk.McpServer {
	var env []acpsdk.EnvVariable
	args := []string{"-y", ampMcpRemotePackage, entry.URL}
	if entry.Token != "" {
		env = append(env, acpsdk.EnvVariable{
			Name:  ampMcpTokenEnvVar,
			Value: entry.Token,
		})
		// mcp-remote expands ${ENV_VAR} references in --header values internally.
		// The token is passed via env var (not in CLI args) to avoid /proc visibility.
		args = append(args, "--header", "Authorization:Bearer ${"+ampMcpTokenEnvVar+"}")
	}
	args = append(args, "--silent")

	return acpsdk.McpServer{
		Stdio: &acpsdk.McpServerStdio{
			Name:    name,
			Command: "npx",
			Args:    args,
			Env:     env,
		},
	}
}
