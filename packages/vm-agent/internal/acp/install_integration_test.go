//go:build integration

package acp

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Test helpers (mirrors bootstrap_integration_test.go patterns)
// ---------------------------------------------------------------------------

func requireDockerAvailable(t *testing.T) {
	t.Helper()
	if out, err := exec.Command("docker", "info").CombinedOutput(); err != nil {
		t.Skipf("Docker not available: %v\n%s", err, string(out))
	}
}

func requireDevcontainerCLI(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("devcontainer"); err != nil {
		t.Skip("devcontainer CLI not installed")
	}
}

func mustStartContainer(t *testing.T, image, labelKey, labelValue string, extraArgs ...string) string {
	t.Helper()
	label := fmt.Sprintf("%s=%s", labelKey, labelValue)
	args := []string{"run", "-d", "--label", label}
	args = append(args, extraArgs...)
	args = append(args, image, "sleep", "infinity")
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker run %s failed: %v\n%s", image, err, string(out))
	}
	containerID := strings.TrimSpace(string(out))
	t.Cleanup(func() {
		_ = exec.Command("docker", "rm", "-f", containerID).Run()
	})
	return containerID
}

func mustCreateTestRepo(t *testing.T, withDevcontainerConfig bool, devcontainerJSON string) string {
	t.Helper()
	dir := t.TempDir()

	cmds := [][]string{
		{"git", "init", dir},
		{"git", "-C", dir, "config", "user.email", "test@example.com"},
		{"git", "-C", dir, "config", "user.name", "Test User"},
	}
	for _, args := range cmds {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("%s failed: %v\n%s", strings.Join(args, " "), err, string(out))
		}
	}

	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Test Repo\n"), 0o644); err != nil {
		t.Fatalf("write README: %v", err)
	}

	if withDevcontainerConfig && devcontainerJSON != "" {
		dcDir := filepath.Join(dir, ".devcontainer")
		if err := os.MkdirAll(dcDir, 0o755); err != nil {
			t.Fatalf("mkdir .devcontainer: %v", err)
		}
		if err := os.WriteFile(filepath.Join(dcDir, "devcontainer.json"), []byte(devcontainerJSON), 0o644); err != nil {
			t.Fatalf("write devcontainer.json: %v", err)
		}
	}

	addAndCommit := [][]string{
		{"git", "-C", dir, "add", "."},
		{"git", "-C", dir, "commit", "-m", "initial commit"},
	}
	for _, args := range addAndCommit {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("%s failed: %v\n%s", strings.Join(args, " "), err, string(out))
		}
	}

	return dir
}

// ---------------------------------------------------------------------------
// Mock agent definitions
// ---------------------------------------------------------------------------

// mockAgentInfo returns an agentCommandInfo that creates a simple executable
// shell script at /usr/local/bin/<binaryName> without requiring npm. This
// exercises the install machinery (root execution, PATH, permissions) without
// network access.
func mockAgentInfo(binaryName string) agentCommandInfo {
	installCmd := fmt.Sprintf(
		`printf '#!/bin/sh\necho "%s v0.0.1-test"' > /usr/local/bin/%s && chmod +x /usr/local/bin/%s`,
		binaryName, binaryName, binaryName,
	)
	return agentCommandInfo{
		command:    binaryName,
		envVarName: "TEST_API_KEY",
		installCmd: installCmd,
	}
}

// mockAgentInfoRequiringNpm returns an agentCommandInfo that first validates
// npm is available (triggering the apt-get fallback on bare images), then
// creates the mock binary. This tests the full npm bootstrap path.
func mockAgentInfoRequiringNpm(binaryName string) agentCommandInfo {
	installCmd := fmt.Sprintf(
		`npm --version >/dev/null 2>&1 || { echo "npm not found after install"; exit 1; }; printf '#!/bin/sh\necho "%s v0.0.1-test"' > /usr/local/bin/%s && chmod +x /usr/local/bin/%s`,
		binaryName, binaryName, binaryName,
	)
	return agentCommandInfo{
		command:    binaryName,
		envVarName: "TEST_API_KEY",
		installCmd: installCmd,
	}
}

// ---------------------------------------------------------------------------
// Shared verification
// ---------------------------------------------------------------------------

// verifyBinaryInstalled checks that binaryName is installed, executable, and
// invocable inside the container.
func verifyBinaryInstalled(t *testing.T, ctx context.Context, containerID, binaryName string) {
	t.Helper()

	// 1. `which` finds it
	out, err := exec.CommandContext(ctx, "docker", "exec", containerID, "which", binaryName).CombinedOutput()
	if err != nil {
		t.Fatalf("which %s failed: %v\n%s", binaryName, err, string(out))
	}
	binaryPath := strings.TrimSpace(string(out))

	// 2. It's executable
	out, err = exec.CommandContext(ctx, "docker", "exec", containerID, "test", "-x", binaryPath).CombinedOutput()
	if err != nil {
		t.Fatalf("binary %s at %s not executable: %v\n%s", binaryName, binaryPath, err, string(out))
	}

	// 3. It produces expected output when invoked
	out, err = exec.CommandContext(ctx, "docker", "exec", containerID, binaryName).CombinedOutput()
	if err != nil {
		t.Fatalf("invoking %s failed: %v\n%s", binaryName, err, string(out))
	}
	if !strings.Contains(string(out), "v0.0.1-test") {
		t.Fatalf("expected mock version output from %s, got: %s", binaryName, string(out))
	}
}

// verifyBinaryAccessibleByUser checks that a non-root user can invoke the binary.
func verifyBinaryAccessibleByUser(t *testing.T, ctx context.Context, containerID, binaryName, user string) {
	t.Helper()

	out, err := exec.CommandContext(ctx, "docker", "exec", "-u", user, containerID, binaryName).CombinedOutput()
	if err != nil {
		t.Fatalf("invoking %s as user %s failed: %v\n%s", binaryName, user, err, string(out))
	}
	if !strings.Contains(string(out), "v0.0.1-test") {
		t.Fatalf("expected mock version output from %s as user %s, got: %s", binaryName, user, string(out))
	}
}

// ---------------------------------------------------------------------------
// Category 1: Docker-run based tests (fast, no devcontainer build)
// ---------------------------------------------------------------------------

func TestIntegration_InstallAgent_NodeImage_HasNpm(t *testing.T) {
	requireDockerAvailable(t)

	containerID := mustStartContainer(t, "node:22-bookworm", "test.label", t.Name())
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	info := mockAgentInfo("test-agent-node")

	if err := installAgentBinary(ctx, containerID, info); err != nil {
		t.Fatalf("installAgentBinary: %v", err)
	}

	verifyBinaryInstalled(t, ctx, containerID, "test-agent-node")
}

func TestIntegration_InstallAgent_NodeImage_NonRootDefault(t *testing.T) {
	requireDockerAvailable(t)

	// Run container as non-root user (node:node, uid 1000)
	containerID := mustStartContainer(t, "node:22-bookworm", "test.label", t.Name(), "--user", "node:node")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	info := mockAgentInfo("test-agent-nonroot")

	if err := installAgentBinary(ctx, containerID, info); err != nil {
		t.Fatalf("installAgentBinary: %v", err)
	}

	// Binary installed as root should be accessible to non-root user
	verifyBinaryInstalled(t, ctx, containerID, "test-agent-nonroot")
	verifyBinaryAccessibleByUser(t, ctx, containerID, "test-agent-nonroot", "node")
}

func TestIntegration_InstallAgent_BareDebian_NoNpm(t *testing.T) {
	requireDockerAvailable(t)

	containerID := mustStartContainer(t, "debian:bookworm-slim", "test.label", t.Name())
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	// Use the npm-requiring variant to verify apt-get bootstraps nodejs+npm
	info := mockAgentInfoRequiringNpm("test-agent-debian")

	if err := installAgentBinary(ctx, containerID, info); err != nil {
		t.Fatalf("installAgentBinary on bare Debian: %v", err)
	}

	verifyBinaryInstalled(t, ctx, containerID, "test-agent-debian")

	// Verify npm was actually installed
	out, err := exec.CommandContext(ctx, "docker", "exec", containerID, "npm", "--version").CombinedOutput()
	if err != nil {
		t.Fatalf("npm --version failed after install: %v\n%s", err, string(out))
	}
	t.Logf("npm installed: %s", strings.TrimSpace(string(out)))
}

func TestIntegration_InstallAgent_DevcontainerBase_VscodeUser(t *testing.T) {
	requireDockerAvailable(t)

	containerID := mustStartContainer(t, "mcr.microsoft.com/devcontainers/base:debian", "test.label", t.Name())
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	info := mockAgentInfo("test-agent-vscode")

	if err := installAgentBinary(ctx, containerID, info); err != nil {
		t.Fatalf("installAgentBinary on devcontainer base: %v", err)
	}

	verifyBinaryInstalled(t, ctx, containerID, "test-agent-vscode")

	// Verify vscode user can invoke the binary
	verifyBinaryAccessibleByUser(t, ctx, containerID, "test-agent-vscode", "vscode")
}

func TestIntegration_InstallAgent_AlreadyInstalled(t *testing.T) {
	requireDockerAvailable(t)

	containerID := mustStartContainer(t, "node:22-bookworm", "test.label", t.Name())
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	binaryName := "test-agent-idempotent"

	// Pre-install the binary manually
	script := fmt.Sprintf(`printf '#!/bin/sh\necho "%s v0.0.1-test"' > /usr/local/bin/%s && chmod +x /usr/local/bin/%s`, binaryName, binaryName, binaryName)
	out, err := exec.CommandContext(ctx, "docker", "exec", containerID, "sh", "-c", script).CombinedOutput()
	if err != nil {
		t.Fatalf("pre-install failed: %v\n%s", err, string(out))
	}

	info := mockAgentInfo(binaryName)

	// installAgentBinary should detect it and return immediately
	if err := installAgentBinary(ctx, containerID, info); err != nil {
		t.Fatalf("installAgentBinary (idempotent): %v", err)
	}

	verifyBinaryInstalled(t, ctx, containerID, binaryName)
}

// ---------------------------------------------------------------------------
// Category 2: Devcontainer-build based tests (slower, real devcontainer up)
// ---------------------------------------------------------------------------

func TestIntegration_InstallAgent_Devcontainer_CustomDockerfile(t *testing.T) {
	requireDockerAvailable(t)
	requireDevcontainerCLI(t)

	// Create a repo with Dockerfile-based devcontainer and custom non-root user
	dir := t.TempDir()

	cmds := [][]string{
		{"git", "init", dir},
		{"git", "-C", dir, "config", "user.email", "test@example.com"},
		{"git", "-C", dir, "config", "user.name", "Test User"},
	}
	for _, args := range cmds {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("%s failed: %v\n%s", strings.Join(args, " "), err, string(out))
		}
	}

	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Dockerfile Test\n"), 0o644); err != nil {
		t.Fatalf("write README: %v", err)
	}

	dcDir := filepath.Join(dir, ".devcontainer")
	if err := os.MkdirAll(dcDir, 0o755); err != nil {
		t.Fatalf("mkdir .devcontainer: %v", err)
	}

	dockerfile := `FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash devuser
`
	if err := os.WriteFile(filepath.Join(dcDir, "Dockerfile"), []byte(dockerfile), 0o644); err != nil {
		t.Fatalf("write Dockerfile: %v", err)
	}

	devcontainerJSON := `{
		"build": { "dockerfile": "Dockerfile" },
		"remoteUser": "devuser"
	}`
	if err := os.WriteFile(filepath.Join(dcDir, "devcontainer.json"), []byte(devcontainerJSON), 0o644); err != nil {
		t.Fatalf("write devcontainer.json: %v", err)
	}

	addAndCommit := [][]string{
		{"git", "-C", dir, "add", "."},
		{"git", "-C", dir, "commit", "-m", "initial commit"},
	}
	for _, args := range addAndCommit {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("%s failed: %v\n%s", strings.Join(args, " "), err, string(out))
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// Build devcontainer
	dcArgs := []string{"up", "--workspace-folder", dir}
	dcCmd := exec.CommandContext(ctx, "devcontainer", dcArgs...)
	output, err := dcCmd.CombinedOutput()
	if err != nil {
		t.Fatalf("devcontainer up failed: %v\n%s", err, string(output))
	}

	// Find the container
	labelFilter := fmt.Sprintf("label=devcontainer.local_folder=%s", dir)
	out, err := exec.CommandContext(ctx, "docker", "ps", "-q", "--filter", labelFilter).CombinedOutput()
	if err != nil {
		t.Fatalf("docker ps: %v\n%s", err, string(out))
	}
	containerID := strings.TrimSpace(string(out))
	if containerID == "" {
		t.Fatal("no devcontainer found after build")
	}

	t.Cleanup(func() {
		_ = exec.Command("docker", "rm", "-f", containerID).Run()
	})

	// Install agent binary in the devcontainer
	info := mockAgentInfoRequiringNpm("test-agent-dockerfile")

	if err := installAgentBinary(ctx, containerID, info); err != nil {
		t.Fatalf("installAgentBinary in Dockerfile-based container: %v", err)
	}

	verifyBinaryInstalled(t, ctx, containerID, "test-agent-dockerfile")

	// Verify devuser can invoke the binary
	verifyBinaryAccessibleByUser(t, ctx, containerID, "test-agent-dockerfile", "devuser")

	t.Logf("Agent install in Dockerfile-based devcontainer with custom user: OK")
}

func TestIntegration_InstallAgent_Devcontainer_WithNodeFeature(t *testing.T) {
	requireDockerAvailable(t)
	requireDevcontainerCLI(t)

	// Base image + node feature — npm should already be present from the feature
	devcontainerJSON := `{
		"image": "mcr.microsoft.com/devcontainers/base:debian",
		"features": {
			"ghcr.io/devcontainers/features/node:1": { "version": "22" }
		}
	}`
	repo := mustCreateTestRepo(t, true, devcontainerJSON)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// Build devcontainer
	dcArgs := []string{"up", "--workspace-folder", repo}
	dcCmd := exec.CommandContext(ctx, "devcontainer", dcArgs...)
	output, err := dcCmd.CombinedOutput()
	if err != nil {
		t.Fatalf("devcontainer up failed: %v\n%s", err, string(output))
	}

	// Find the container
	labelFilter := fmt.Sprintf("label=devcontainer.local_folder=%s", repo)
	out, err := exec.CommandContext(ctx, "docker", "ps", "-q", "--filter", labelFilter).CombinedOutput()
	if err != nil {
		t.Fatalf("docker ps: %v\n%s", err, string(out))
	}
	containerID := strings.TrimSpace(string(out))
	if containerID == "" {
		t.Fatal("no devcontainer found after build")
	}

	t.Cleanup(func() {
		_ = exec.Command("docker", "rm", "-f", containerID).Run()
	})

	// Verify npm is already available (from the node feature)
	out, err = exec.CommandContext(ctx, "docker", "exec", containerID, "npm", "--version").CombinedOutput()
	if err != nil {
		t.Fatalf("npm should be present from node feature: %v\n%s", err, string(out))
	}
	t.Logf("npm from feature: %s", strings.TrimSpace(string(out)))

	// Install agent — should succeed without needing apt-get
	info := mockAgentInfoRequiringNpm("test-agent-feature")

	if err := installAgentBinary(ctx, containerID, info); err != nil {
		t.Fatalf("installAgentBinary in devcontainer with node feature: %v", err)
	}

	verifyBinaryInstalled(t, ctx, containerID, "test-agent-feature")

	// Verify vscode user can invoke the binary
	verifyBinaryAccessibleByUser(t, ctx, containerID, "test-agent-feature", "vscode")

	t.Logf("Agent install in devcontainer with Node.js feature: OK")
}

// ---------------------------------------------------------------------------
// Category 3: SAM repo devcontainer (typescript-node + features)
// ---------------------------------------------------------------------------

func TestIntegration_InstallAgent_TypescriptNodeImage(t *testing.T) {
	requireDockerAvailable(t)

	// Our SAM repo uses mcr.microsoft.com/devcontainers/typescript-node:22-bookworm.
	// This is NOT the same as bare node:22. The devcontainer image has different
	// PATH structure, tooling, and runs as the "node" user by default.
	containerID := mustStartContainer(t, "mcr.microsoft.com/devcontainers/typescript-node:22-bookworm", "test.label", t.Name())
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	info := mockAgentInfo("test-agent-tsnode")

	if err := installAgentBinary(ctx, containerID, info); err != nil {
		t.Fatalf("installAgentBinary on typescript-node image: %v", err)
	}

	verifyBinaryInstalled(t, ctx, containerID, "test-agent-tsnode")

	// Verify node user can invoke the binary (default user for this image)
	verifyBinaryAccessibleByUser(t, ctx, containerID, "test-agent-tsnode", "node")
}

func TestIntegration_InstallAgent_Devcontainer_SAMRepoConfig(t *testing.T) {
	requireDockerAvailable(t)
	requireDevcontainerCLI(t)

	// Models the actual SAM repo devcontainer configuration:
	// - typescript-node base image
	// - Go feature (modifies PATH, adds tooling)
	// - GitHub CLI feature
	// - containerEnv settings
	// Note: docker-in-docker is excluded because it requires --privileged and
	// isn't relevant to agent binary installation.
	devcontainerJSON := `{
		"image": "mcr.microsoft.com/devcontainers/typescript-node:22-bookworm",
		"containerEnv": {
			"CLAUDE_CONFIG_DIR": "/workspaces/claude-home"
		},
		"features": {
			"ghcr.io/devcontainers/features/github-cli:1": {},
			"ghcr.io/devcontainers/features/go:1": { "version": "1.22" }
		}
	}`
	repo := mustCreateTestRepo(t, true, devcontainerJSON)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// Build devcontainer
	dcArgs := []string{"up", "--workspace-folder", repo}
	dcCmd := exec.CommandContext(ctx, "devcontainer", dcArgs...)
	output, err := dcCmd.CombinedOutput()
	if err != nil {
		t.Fatalf("devcontainer up failed: %v\n%s", err, string(output))
	}

	// Find the container
	labelFilter := fmt.Sprintf("label=devcontainer.local_folder=%s", repo)
	out, err := exec.CommandContext(ctx, "docker", "ps", "-q", "--filter", labelFilter).CombinedOutput()
	if err != nil {
		t.Fatalf("docker ps: %v\n%s", err, string(out))
	}
	containerID := strings.TrimSpace(string(out))
	if containerID == "" {
		t.Fatal("no devcontainer found after build")
	}

	t.Cleanup(func() {
		_ = exec.Command("docker", "rm", "-f", containerID).Run()
	})

	// Verify environment matches expectations
	out, err = exec.CommandContext(ctx, "docker", "exec", containerID, "go", "version").CombinedOutput()
	if err != nil {
		t.Fatalf("go not available in SAM-style devcontainer: %v\n%s", err, string(out))
	}
	t.Logf("Go version: %s", strings.TrimSpace(string(out)))

	out, err = exec.CommandContext(ctx, "docker", "exec", containerID, "gh", "--version").CombinedOutput()
	if err != nil {
		t.Fatalf("gh CLI not available in SAM-style devcontainer: %v\n%s", err, string(out))
	}
	t.Logf("GitHub CLI: %s", strings.TrimSpace(string(out)))

	// Install agent binary
	info := mockAgentInfo("test-agent-sam")

	if err := installAgentBinary(ctx, containerID, info); err != nil {
		t.Fatalf("installAgentBinary in SAM-style devcontainer: %v", err)
	}

	verifyBinaryInstalled(t, ctx, containerID, "test-agent-sam")

	// Verify node user can invoke it (typescript-node default user)
	verifyBinaryAccessibleByUser(t, ctx, containerID, "test-agent-sam", "node")

	t.Logf("Agent install in SAM repo-style devcontainer: OK")
}

// ---------------------------------------------------------------------------
// Category 4: Real agent binary (npm install + Claude CLI, network required)
// ---------------------------------------------------------------------------

// TestIntegration_InstallAgent_RealClaudeCodeACP installs the actual
// @zed-industries/claude-code-acp package and Claude Code CLI inside a
// SAM-style devcontainer, then verifies they work together.
//
// This test requires network access (npm registry + claude.ai) and takes
// longer than mock-based tests. It exercises the real production install path.
func TestIntegration_InstallAgent_RealClaudeCodeACP(t *testing.T) {
	requireDockerAvailable(t)
	requireDevcontainerCLI(t)

	// Use our actual SAM-style devcontainer (typescript-node with features)
	devcontainerJSON := `{
		"image": "mcr.microsoft.com/devcontainers/typescript-node:22-bookworm",
		"features": {
			"ghcr.io/devcontainers/features/github-cli:1": {},
			"ghcr.io/devcontainers/features/go:1": { "version": "1.22" }
		}
	}`
	repo := mustCreateTestRepo(t, true, devcontainerJSON)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	// Build devcontainer
	dcArgs := []string{"up", "--workspace-folder", repo}
	dcCmd := exec.CommandContext(ctx, "devcontainer", dcArgs...)
	output, err := dcCmd.CombinedOutput()
	if err != nil {
		t.Fatalf("devcontainer up failed: %v\n%s", err, string(output))
	}

	// Find the container
	labelFilter := fmt.Sprintf("label=devcontainer.local_folder=%s", repo)
	out, err := exec.CommandContext(ctx, "docker", "ps", "-q", "--filter", labelFilter).CombinedOutput()
	if err != nil {
		t.Fatalf("docker ps: %v\n%s", err, string(out))
	}
	containerID := strings.TrimSpace(string(out))
	if containerID == "" {
		t.Fatal("no devcontainer found after build")
	}

	t.Cleanup(func() {
		_ = exec.Command("docker", "rm", "-f", containerID).Run()
	})

	// Step 1: Install claude-code-acp using the REAL production install path
	realInfo := getAgentCommandInfo("claude-code", "")
	t.Logf("Installing real agent: command=%s, installCmd=%s", realInfo.command, realInfo.installCmd)

	if err := installAgentBinary(ctx, containerID, realInfo); err != nil {
		t.Fatalf("installAgentBinary with real claude-code-acp: %v", err)
	}

	// Verify claude-code-acp is installed
	out, err = exec.CommandContext(ctx, "docker", "exec", containerID, "which", "claude-code-acp").CombinedOutput()
	if err != nil {
		t.Fatalf("claude-code-acp not found after install: %v\n%s", err, string(out))
	}
	t.Logf("claude-code-acp location: %s", strings.TrimSpace(string(out)))

	// Verify non-root user (node) can find and execute claude-code-acp
	out, err = exec.CommandContext(ctx, "docker", "exec", "-u", "node", containerID, "which", "claude-code-acp").CombinedOutput()
	if err != nil {
		t.Fatalf("claude-code-acp not accessible by node user: %v\n%s", err, string(out))
	}
	t.Logf("claude-code-acp accessible by node user at: %s", strings.TrimSpace(string(out)))

	// Step 2: Install Claude Code CLI (the underlying CLI that claude-code-acp wraps)
	// Install as the node user so it lands in /home/node/.local/bin/ (matching production
	// where the devcontainer's default user runs the install script).
	// Then symlink to /usr/local/bin/ so it's on everyone's PATH.
	installClaude := `curl -fsSL https://claude.ai/install.sh | bash`
	installArgs := []string{"exec", "-u", "node", "-e", "HOME=/home/node", containerID, "bash", "-c", installClaude}
	out, err = exec.CommandContext(ctx, "docker", installArgs...).CombinedOutput()
	if err != nil {
		t.Fatalf("Claude Code CLI install failed: %v\n%s", err, string(out))
	}
	t.Logf("Claude CLI installed")

	// Symlink to a PATH location so all users can find it
	symlinkCmd := `ln -sf /home/node/.local/bin/claude /usr/local/bin/claude`
	out, err = exec.CommandContext(ctx, "docker", "exec", "-u", "root", containerID, "sh", "-c", symlinkCmd).CombinedOutput()
	if err != nil {
		t.Fatalf("symlink claude to /usr/local/bin failed: %v\n%s", err, string(out))
	}

	// Verify claude CLI is installed and accessible
	out, err = exec.CommandContext(ctx, "docker", "exec", containerID, "claude", "--version").CombinedOutput()
	if err != nil {
		t.Fatalf("claude --version failed: %v\n%s", err, string(out))
	}
	t.Logf("claude version: %s", strings.TrimSpace(string(out)))

	// Step 3: Verify claude-code-acp + claude CLI work together via ACP protocol.
	// Send an ACP Initialize JSON-RPC message to stdin and verify we get a valid
	// response with agent capabilities. This is the critical integration point:
	// claude-code-acp must find claude CLI and successfully negotiate the protocol.
	acpInitMsg := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"capabilities":{},"clientInfo":{"name":"test","version":"0.1"}}}`
	acpTestScript := fmt.Sprintf(`echo '%s' | timeout 15 claude-code-acp 2>/dev/null`, acpInitMsg)
	out, err = exec.CommandContext(ctx, "docker", "exec", "-u", "node", containerID, "bash", "-c", acpTestScript).CombinedOutput()
	if err != nil {
		t.Fatalf("ACP Initialize handshake failed: %v\n%s", err, string(out))
	}
	acpResponse := strings.TrimSpace(string(out))
	t.Logf("ACP Initialize response: %s", acpResponse)

	// Verify response is valid JSON-RPC with agent info
	if !strings.Contains(acpResponse, `"jsonrpc":"2.0"`) {
		t.Fatalf("expected JSON-RPC response, got: %s", acpResponse)
	}
	if !strings.Contains(acpResponse, "claude-code-acp") {
		t.Fatalf("expected agent name in response, got: %s", acpResponse)
	}
	if !strings.Contains(acpResponse, `"agentCapabilities"`) {
		t.Fatalf("expected agentCapabilities in response, got: %s", acpResponse)
	}

	t.Logf("Real Claude Code ACP + CLI integration test: OK")
}

// ---------------------------------------------------------------------------
// Category 5: Python devcontainer (no npm by default)
// ---------------------------------------------------------------------------

func TestIntegration_InstallAgent_Devcontainer_PythonImage(t *testing.T) {
	requireDockerAvailable(t)
	requireDevcontainerCLI(t)

	// Python devcontainer — no Node.js or npm by default. This is a common
	// real-world scenario where users bring Python projects to SAM.
	devcontainerJSON := `{
		"image": "mcr.microsoft.com/devcontainers/python:3.12"
	}`
	repo := mustCreateTestRepo(t, true, devcontainerJSON)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// Build devcontainer
	dcArgs := []string{"up", "--workspace-folder", repo}
	dcCmd := exec.CommandContext(ctx, "devcontainer", dcArgs...)
	output, err := dcCmd.CombinedOutput()
	if err != nil {
		t.Fatalf("devcontainer up failed: %v\n%s", err, string(output))
	}

	// Find the container
	labelFilter := fmt.Sprintf("label=devcontainer.local_folder=%s", repo)
	out, err := exec.CommandContext(ctx, "docker", "ps", "-q", "--filter", labelFilter).CombinedOutput()
	if err != nil {
		t.Fatalf("docker ps: %v\n%s", err, string(out))
	}
	containerID := strings.TrimSpace(string(out))
	if containerID == "" {
		t.Fatal("no devcontainer found after build")
	}

	t.Cleanup(func() {
		_ = exec.Command("docker", "rm", "-f", containerID).Run()
	})

	// Install agent — should auto-install npm via apt-get, then install agent
	info := mockAgentInfoRequiringNpm("test-agent-python")

	if err := installAgentBinary(ctx, containerID, info); err != nil {
		t.Fatalf("installAgentBinary in Python devcontainer: %v", err)
	}

	verifyBinaryInstalled(t, ctx, containerID, "test-agent-python")

	// Verify vscode user can invoke the binary
	verifyBinaryAccessibleByUser(t, ctx, containerID, "test-agent-python", "vscode")

	t.Logf("Agent install in Python devcontainer (no npm by default): OK")
}
