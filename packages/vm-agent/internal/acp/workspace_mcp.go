package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"
)

// DefaultWorkspaceMcpBinaryPath is the default path for the workspace MCP
// server binary inside the devcontainer. Override via WORKSPACE_MCP_BINARY_PATH
// env var on the VM agent.
const DefaultWorkspaceMcpBinaryPath = "/usr/local/lib/workspace-mcp/index.js"

// workspaceMcpJsonConfig represents the .mcp.json file format used by Claude Code
// for stdio MCP server configuration.
type workspaceMcpJsonConfig struct {
	McpServers map[string]workspaceMcpServerEntry `json:"mcpServers"`
}

type workspaceMcpServerEntry struct {
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env,omitempty"`
}

// generateWorkspaceMcpJson creates the .mcp.json content for injecting the
// workspace-aware MCP server into Claude Code sessions. The MCP server is
// a stdio process that gives agents platform-level awareness (network info,
// cost estimates, multi-agent coordination, CI/CD status, etc.).
func generateWorkspaceMcpJson(binaryPath, mcpToken, apiURL string, existingMcpServers []McpServerEntry) (string, error) {
	env := map[string]string{}

	if mcpToken != "" {
		env["SAM_MCP_TOKEN"] = mcpToken
	}
	if apiURL != "" {
		env["SAM_API_URL"] = apiURL
	}

	// If there's an existing SAM MCP server, pass its token so the workspace
	// MCP server can proxy calls through it. Use first-match semantics to be
	// consistent with the extraction logic in session_host.go.
	for _, srv := range existingMcpServers {
		if srv.Token != "" && mcpToken == "" {
			env["SAM_MCP_TOKEN"] = srv.Token
			break
		}
	}
	for _, srv := range existingMcpServers {
		if srv.URL != "" && apiURL == "" {
			env["SAM_API_URL"] = srv.URL
			break
		}
	}

	config := workspaceMcpJsonConfig{
		McpServers: map[string]workspaceMcpServerEntry{
			"workspace-mcp": {
				Command: "node",
				Args:    []string{binaryPath},
				Env:     env,
			},
		},
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return "", fmt.Errorf("marshal workspace MCP config: %w", err)
	}
	return string(data), nil
}

// writeWorkspaceMcpConfig writes .mcp.json into the container's workspace
// directory so Claude Code discovers the workspace-aware MCP server at
// session start. The file is written via stdin to avoid exposing tokens
// in process arguments.
//
// This is non-fatal: if writing fails, the agent session continues without
// the workspace MCP server (agents still have the HTTP SAM MCP server).
func writeWorkspaceMcpConfig(ctx context.Context, containerID, user, workDir, binaryPath, mcpToken, apiURL string, mcpServers []McpServerEntry) error {
	if workDir == "" {
		return fmt.Errorf("workDir is empty, cannot write .mcp.json")
	}

	config, err := generateWorkspaceMcpJson(binaryPath, mcpToken, apiURL, mcpServers)
	if err != nil {
		return err
	}

	// Write to workspace directory (not home dir) so Claude Code picks it up
	// as a project-level MCP config.
	targetPath := workDir + "/.mcp.json"

	// Write .mcp.json and add it to .gitignore to prevent accidental commits.
	// Also schedule cleanup note: the session teardown should rm this file.
	gitignorePath := workDir + "/.gitignore"
	script := fmt.Sprintf(
		`set -e; cat > %q && chmod 600 %q && grep -qxF '.mcp.json' %q 2>/dev/null || echo '.mcp.json' >> %q`,
		targetPath, targetPath, gitignorePath, gitignorePath,
	)

	dockerArgs := []string{"exec", "-i"}
	if user != "" {
		dockerArgs = append(dockerArgs, "-u", user)
	}
	dockerArgs = append(dockerArgs, containerID, "sh", "-c", script)

	cmd := exec.CommandContext(ctx, "docker", dockerArgs...)
	cmd.Stdin = strings.NewReader(config)

	output, err := cmd.CombinedOutput()
	if err != nil {
		// Truncate output to avoid leaking sensitive data in error messages.
		outStr := strings.TrimSpace(string(output))
		if len(outStr) > 200 {
			outStr = outStr[:200] + "..."
		}
		return fmt.Errorf("docker exec failed writing .mcp.json: %w: %s", err, outStr)
	}
	return nil
}

// injectWorkspaceMcpIfAvailable checks whether the workspace MCP binary is
// installed in the container and, if so, writes .mcp.json for Claude Code.
// Returns true if the config was written successfully.
func injectWorkspaceMcpIfAvailable(ctx context.Context, containerID, user, workDir, binaryPath, mcpToken, apiURL string, mcpServers []McpServerEntry) bool {
	// Check if the binary exists in the container.
	checkArgs := []string{"exec"}
	if user != "" {
		checkArgs = append(checkArgs, "-u", user)
	}
	checkArgs = append(checkArgs, containerID, "test", "-f", binaryPath)

	checkCmd := exec.CommandContext(ctx, "docker", checkArgs...)
	if err := checkCmd.Run(); err != nil {
		slog.Debug("workspace-mcp binary not found in container",
			"path", binaryPath,
			"error", err)
		return false
	}

	if err := writeWorkspaceMcpConfig(ctx, containerID, user, workDir, binaryPath, mcpToken, apiURL, mcpServers); err != nil {
		slog.Warn("Failed to write workspace MCP config",
			"error", err,
			"containerID", containerID)
		return false
	}

	slog.Info("Injected workspace MCP config",
		"binaryPath", binaryPath,
		"workDir", workDir)
	return true
}
