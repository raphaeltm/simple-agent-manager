// Package bootstrap handles VM startup credential bootstrap and workspace setup.
package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/config"
)

const (
	maxBackoff = 30 * time.Second
)

type bootstrapResponse struct {
	WorkspaceID     string  `json:"workspaceId"`
	CallbackToken   string  `json:"callbackToken"`
	GitHubToken     *string `json:"githubToken"`
	GitUserName     *string `json:"gitUserName"`
	GitUserEmail    *string `json:"gitUserEmail"`
	ControlPlaneURL string  `json:"controlPlaneUrl"`
}

type bootstrapState struct {
	WorkspaceID   string `json:"workspaceId"`
	CallbackToken string `json:"callbackToken"`
	GitHubToken   string `json:"githubToken,omitempty"`
	GitUserName   string `json:"gitUserName,omitempty"`
	GitUserEmail  string `json:"gitUserEmail,omitempty"`
}

// ProvisionState carries optional credential and git identity data used when
// preparing a workspace environment outside the bootstrap-token flow.
type ProvisionState struct {
	GitHubToken  string
	GitUserName  string
	GitUserEmail string
}

// Run redeems bootstrap credentials (if configured), prepares the workspace, and signals ready.
// The reporter is used to send structured boot log entries to the control plane for UI display.
// It is safe to pass a nil reporter.
func Run(ctx context.Context, cfg *config.Config, reporter *bootlog.Reporter) error {
	if cfg.BootstrapToken == "" {
		return nil
	}

	state, err := loadState(cfg.BootstrapStatePath)
	if err != nil {
		return fmt.Errorf("failed to load bootstrap state: %w", err)
	}

	if state != nil {
		if state.WorkspaceID != cfg.WorkspaceID {
			return fmt.Errorf("bootstrap state workspace mismatch: expected %s, found %s", cfg.WorkspaceID, state.WorkspaceID)
		}
		log.Printf("Using cached bootstrap state from %s", cfg.BootstrapStatePath)
		cfg.CallbackToken = state.CallbackToken
		reporter.SetToken(state.CallbackToken)
	} else {
		reporter.Log("bootstrap_redeem", "started", "Redeeming bootstrap credentials")
		state, err = redeemBootstrapTokenWithRetry(ctx, cfg)
		if err != nil {
			return err
		}
		cfg.CallbackToken = state.CallbackToken
		reporter.SetToken(state.CallbackToken)
		reporter.Log("bootstrap_redeem", "completed", "Bootstrap credentials redeemed")
		if err := saveState(cfg.BootstrapStatePath, state); err != nil {
			return fmt.Errorf("failed to persist bootstrap state: %w", err)
		}
	}

	if cfg.CallbackToken == "" {
		return errors.New("callback token is missing after bootstrap")
	}

	reporter.Log("git_clone", "started", "Cloning repository")
	if err := ensureRepositoryReady(ctx, cfg, state); err != nil {
		reporter.Log("git_clone", "failed", "Repository clone failed", err.Error())
		return err
	}
	reporter.Log("git_clone", "completed", "Repository cloned")

	reporter.Log("workspace_perms_pre", "started", "Preparing workspace permissions")
	if err := ensureWorkspaceWritablePreDevcontainer(ctx, cfg); err != nil {
		reporter.Log("workspace_perms_pre", "failed", "Pre-devcontainer permission setup failed", err.Error())
		return err
	}
	reporter.Log("workspace_perms_pre", "completed", "Workspace permissions prepared")

	reporter.Log("devcontainer_wait", "started", "Waiting for devcontainer CLI")
	reporter.Log("devcontainer_up", "started", "Building devcontainer")
	usedFallback, err := ensureDevcontainerReady(ctx, cfg)
	if err != nil {
		reporter.Log("devcontainer_up", "failed", "Devcontainer build failed", err.Error())
		return err
	}
	if usedFallback {
		reporter.Log("devcontainer_up", "completed", "Devcontainer ready (fallback to default image)")
	} else {
		reporter.Log("devcontainer_up", "completed", "Devcontainer ready")
	}

	reporter.Log("workspace_perms", "started", "Setting workspace permissions")
	if err := ensureWorkspaceWritable(ctx, cfg); err != nil {
		reporter.Log("workspace_perms", "failed", "Permission setup failed", err.Error())
		return err
	}
	reporter.Log("workspace_perms", "completed", "Workspace permissions set")

	reporter.Log("git_creds", "started", "Configuring git credentials")
	if err := ensureGitCredentialHelper(ctx, cfg); err != nil {
		reporter.Log("git_creds", "failed", "Git credential setup failed", err.Error())
		return err
	}
	reporter.Log("git_creds", "completed", "Git credentials configured")

	reporter.Log("git_identity", "started", "Configuring git identity")
	if err := ensureGitIdentity(ctx, cfg, state); err != nil {
		reporter.Log("git_identity", "failed", "Git identity setup failed", err.Error())
		return err
	}
	reporter.Log("git_identity", "completed", "Git identity configured")

	reporter.Log("workspace_ready", "started", "Marking workspace ready")
	if err := markWorkspaceReady(ctx, cfg); err != nil {
		reporter.Log("workspace_ready", "failed", "Failed to mark workspace ready", err.Error())
		return err
	}
	reporter.Log("workspace_ready", "completed", "Workspace is ready")

	return nil
}

// PrepareWorkspace provisions a workspace repository/devcontainer and configures
// git credentials/identity using the provided state. This is used by node-mode
// workspace creation where workspaces are prepared on demand rather than at VM boot.
// Returns (usedFallback, error) where usedFallback is true if the devcontainer
// build fell back to the default image.
func PrepareWorkspace(ctx context.Context, cfg *config.Config, state ProvisionState) (bool, error) {
	if cfg == nil {
		return false, errors.New("config is required")
	}

	bootstrap := &bootstrapState{
		WorkspaceID:   cfg.WorkspaceID,
		CallbackToken: cfg.CallbackToken,
		GitHubToken:   strings.TrimSpace(state.GitHubToken),
		GitUserName:   strings.TrimSpace(state.GitUserName),
		GitUserEmail:  strings.TrimSpace(state.GitUserEmail),
	}

	if err := ensureRepositoryReady(ctx, cfg, bootstrap); err != nil {
		return false, err
	}
	if err := ensureWorkspaceWritablePreDevcontainer(ctx, cfg); err != nil {
		return false, err
	}
	usedFallback, err := ensureDevcontainerReady(ctx, cfg)
	if err != nil {
		return false, err
	}
	if err := ensureWorkspaceWritable(ctx, cfg); err != nil {
		return usedFallback, err
	}
	if err := ensureGitCredentialHelper(ctx, cfg); err != nil {
		return usedFallback, err
	}
	if err := ensureGitIdentity(ctx, cfg, bootstrap); err != nil {
		return usedFallback, err
	}
	if err := markWorkspaceReady(ctx, cfg); err != nil {
		return usedFallback, err
	}

	return usedFallback, nil
}

func ensureWorkspaceWritablePreDevcontainer(ctx context.Context, cfg *config.Config) error {
	if cfg.WorkspaceDir == "" {
		return nil
	}
	if !cfg.ContainerMode {
		return nil
	}

	if _, err := os.Stat(cfg.WorkspaceDir); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("failed to stat workspace dir: %w", err)
	}

	// Ensure lifecycle hooks that run as non-root users can mutate the bind mount.
	cmd := exec.CommandContext(ctx, "chmod", "-R", "a+rwX", cfg.WorkspaceDir)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to normalize workspace permissions before devcontainer up: %w: %s", err, strings.TrimSpace(string(output)))
	}

	return nil
}

func ensureWorkspaceWritable(ctx context.Context, cfg *config.Config) error {
	if cfg.WorkspaceDir == "" {
		return nil
	}
	if _, err := os.Stat(cfg.WorkspaceDir); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("failed to stat workspace dir: %w", err)
	}

	// Only needed for devcontainer/bind-mount workflows.
	if !cfg.ContainerMode {
		return nil
	}

	containerID, err := findDevcontainerID(ctx, cfg)
	if err != nil {
		log.Printf("Workspace permission fix skipped: unable to locate devcontainer: %v", err)
		return nil
	}

	uid := 0
	gid := 0
	user := strings.TrimSpace(cfg.ContainerUser)
	if user != "" {
		// Prefer configured user, but fall back to container default user.
		if u, g, err := getContainerUserIDs(ctx, containerID, user); err != nil {
			log.Printf("Workspace permission fix: unable to resolve user %q in devcontainer (%v), falling back to container default user", user, err)
		} else {
			uid, gid = u, g
		}
	}
	if uid == 0 && gid == 0 {
		u, g, err := getContainerCurrentUserIDs(ctx, containerID)
		if err != nil {
			log.Printf("Workspace permission fix skipped: unable to resolve devcontainer user: %v", err)
			return nil
		}
		uid, gid = u, g
	}

	owner := fmt.Sprintf("%d:%d", uid, gid)
	cmd := exec.CommandContext(ctx, "chown", "-R", owner, cfg.WorkspaceDir)
	if output, err := cmd.CombinedOutput(); err != nil {
		log.Printf("Workspace permission fix failed (owner=%s, dir=%s): %v: %s", owner, cfg.WorkspaceDir, err, strings.TrimSpace(string(output)))
		return nil
	}

	return nil
}

func getContainerUserIDs(ctx context.Context, containerID, user string) (int, int, error) {
	uidCmd := exec.CommandContext(ctx, "docker", "exec", containerID, "id", "-u", user)
	uidOut, err := uidCmd.CombinedOutput()
	if err != nil {
		return 0, 0, fmt.Errorf("failed to get uid for %s in devcontainer: %w: %s", user, err, strings.TrimSpace(string(uidOut)))
	}
	uid, err := strconv.Atoi(strings.TrimSpace(string(uidOut)))
	if err != nil {
		return 0, 0, fmt.Errorf("invalid uid output for %s in devcontainer: %q", user, strings.TrimSpace(string(uidOut)))
	}

	gidCmd := exec.CommandContext(ctx, "docker", "exec", containerID, "id", "-g", user)
	gidOut, err := gidCmd.CombinedOutput()
	if err != nil {
		return 0, 0, fmt.Errorf("failed to get gid for %s in devcontainer: %w: %s", user, err, strings.TrimSpace(string(gidOut)))
	}
	gid, err := strconv.Atoi(strings.TrimSpace(string(gidOut)))
	if err != nil {
		return 0, 0, fmt.Errorf("invalid gid output for %s in devcontainer: %q", user, strings.TrimSpace(string(gidOut)))
	}

	return uid, gid, nil
}

func getContainerCurrentUserIDs(ctx context.Context, containerID string) (int, int, error) {
	uidCmd := exec.CommandContext(ctx, "docker", "exec", containerID, "id", "-u")
	uidOut, err := uidCmd.CombinedOutput()
	if err != nil {
		return 0, 0, fmt.Errorf("failed to get current uid in devcontainer: %w: %s", err, strings.TrimSpace(string(uidOut)))
	}
	uid, err := strconv.Atoi(strings.TrimSpace(string(uidOut)))
	if err != nil {
		return 0, 0, fmt.Errorf("invalid uid output in devcontainer: %q", strings.TrimSpace(string(uidOut)))
	}

	gidCmd := exec.CommandContext(ctx, "docker", "exec", containerID, "id", "-g")
	gidOut, err := gidCmd.CombinedOutput()
	if err != nil {
		return 0, 0, fmt.Errorf("failed to get current gid in devcontainer: %w: %s", err, strings.TrimSpace(string(gidOut)))
	}
	gid, err := strconv.Atoi(strings.TrimSpace(string(gidOut)))
	if err != nil {
		return 0, 0, fmt.Errorf("invalid gid output in devcontainer: %q", strings.TrimSpace(string(gidOut)))
	}

	return uid, gid, nil
}

func redeemBootstrapTokenWithRetry(ctx context.Context, cfg *config.Config) (*bootstrapState, error) {
	deadline := time.Now().Add(cfg.BootstrapMaxWait)
	backoff := 1 * time.Second
	var lastErr error

	for {
		state, retryable, err := redeemBootstrapToken(ctx, cfg)
		if err == nil {
			log.Printf("Bootstrap token redeemed successfully for workspace %s", cfg.WorkspaceID)
			return state, nil
		}

		lastErr = err
		if !retryable {
			return nil, fmt.Errorf("bootstrap redemption failed (non-retryable): %w", err)
		}

		if time.Now().After(deadline) {
			return nil, fmt.Errorf("bootstrap redemption timed out after %s: %w", cfg.BootstrapMaxWait, lastErr)
		}

		wait := backoff
		if wait > maxBackoff {
			wait = maxBackoff
		}
		remaining := time.Until(deadline)
		if wait > remaining {
			wait = remaining
		}

		log.Printf("Bootstrap redemption failed, retrying in %s: %v", wait, err)

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wait):
		}

		backoff *= 2
	}
}

func redeemBootstrapToken(ctx context.Context, cfg *config.Config) (*bootstrapState, bool, error) {
	endpoint := fmt.Sprintf("%s/api/bootstrap/%s", strings.TrimRight(cfg.ControlPlaneURL, "/"), cfg.BootstrapToken)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
	if err != nil {
		return nil, true, err
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, true, err
	}
	defer res.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(res.Body, 8*1024))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		retryable := res.StatusCode >= 500 || res.StatusCode == http.StatusTooManyRequests
		if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden || res.StatusCode == http.StatusNotFound {
			retryable = false
		}
		return nil, retryable, fmt.Errorf("bootstrap endpoint returned HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
	}

	var payload bootstrapResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, true, fmt.Errorf("failed to decode bootstrap response: %w", err)
	}

	if payload.WorkspaceID == "" || payload.CallbackToken == "" {
		return nil, false, errors.New("bootstrap response missing required fields")
	}

	if payload.WorkspaceID != cfg.WorkspaceID {
		return nil, false, fmt.Errorf("bootstrap workspace mismatch: expected %s, got %s", cfg.WorkspaceID, payload.WorkspaceID)
	}

	githubToken := ""
	if payload.GitHubToken != nil {
		githubToken = *payload.GitHubToken
	}
	gitUserName := ""
	if payload.GitUserName != nil {
		gitUserName = *payload.GitUserName
	}
	gitUserEmail := ""
	if payload.GitUserEmail != nil {
		gitUserEmail = *payload.GitUserEmail
	}

	return &bootstrapState{
		WorkspaceID:   payload.WorkspaceID,
		CallbackToken: payload.CallbackToken,
		GitHubToken:   githubToken,
		GitUserName:   strings.TrimSpace(gitUserName),
		GitUserEmail:  strings.TrimSpace(gitUserEmail),
	}, false, nil
}

func ensureRepositoryReady(ctx context.Context, cfg *config.Config, state *bootstrapState) error {
	if cfg.Repository == "" {
		log.Printf("Repository is empty, skipping clone step")
		return nil
	}

	gitDir := filepath.Join(cfg.WorkspaceDir, ".git")
	if _, err := os.Stat(gitDir); err == nil {
		log.Printf("Repository already present at %s, skipping clone", cfg.WorkspaceDir)
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(cfg.WorkspaceDir), 0o755); err != nil {
		return fmt.Errorf("failed to create workspace parent directory: %w", err)
	}

	if err := os.RemoveAll(cfg.WorkspaceDir); err != nil {
		return fmt.Errorf("failed to clean workspace directory: %w", err)
	}

	branch := cfg.Branch
	if branch == "" {
		branch = "main"
	}

	repoURL := normalizeRepoURL(cfg.Repository)
	cloneToken := ""
	if state != nil {
		cloneToken = state.GitHubToken
	}

	cloneURL, err := withGitHubToken(repoURL, cloneToken)
	if err != nil {
		return fmt.Errorf("failed to prepare clone URL: %w", err)
	}

	log.Printf("Cloning repository %s (branch: %s) into %s", cfg.Repository, branch, cfg.WorkspaceDir)
	cmd := exec.CommandContext(ctx, "git", "clone", "--branch", branch, "--single-branch", cloneURL, cfg.WorkspaceDir)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git clone failed: %w: %s", err, redactSecret(strings.TrimSpace(string(output)), cloneToken))
	}

	// Persist origin without embedded credentials.
	cmd = exec.CommandContext(ctx, "git", "-C", cfg.WorkspaceDir, "remote", "set-url", "origin", repoURL)
	output, err = cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to sanitize repository origin URL: %w: %s", err, strings.TrimSpace(string(output)))
	}

	return nil
}

// ensureDevcontainerReady builds and starts the devcontainer for the workspace.
// It returns (usedFallback, error) where usedFallback is true if the repo's own
// devcontainer config failed and the default image was used instead.
func ensureDevcontainerReady(ctx context.Context, cfg *config.Config) (bool, error) {
	if _, err := findDevcontainerID(ctx, cfg); err == nil {
		log.Printf("Devcontainer already running for %s=%s", cfg.ContainerLabelKey, cfg.ContainerLabelValue)
		return false, nil
	}

	// Wait for devcontainer CLI to be available. Cloud-init installs Node.js and
	// devcontainer CLI asynchronously AFTER the VM Agent starts — there is a race
	// where the agent tries to run "devcontainer up" before the CLI exists.
	if err := waitForCommand(ctx, "devcontainer"); err != nil {
		return false, fmt.Errorf("devcontainer CLI never became available: %w", err)
	}

	log.Printf("Starting devcontainer for workspace at %s", cfg.WorkspaceDir)

	hasConfig := hasDevcontainerConfig(cfg.WorkspaceDir)

	if hasConfig {
		// Try with repo's own devcontainer config first.
		args := []string{"up", "--workspace-folder", cfg.WorkspaceDir}
		if cfg.AdditionalFeatures != "" {
			log.Printf("Repo has its own devcontainer config — skipping additional-features injection")
		}

		cmd := exec.CommandContext(ctx, "devcontainer", args...)
		output, err := cmd.CombinedOutput()
		if err != nil {
			// Repo config failed — log the error and fall back to default image.
			log.Printf("Devcontainer build failed with repo config, falling back to default image: %v: %s", err, strings.TrimSpace(string(output)))

			// Write build error log to the workspace directory for debugging.
			errorLogPath := filepath.Join(cfg.WorkspaceDir, ".devcontainer-build-error.log")
			if writeErr := os.WriteFile(errorLogPath, output, 0o644); writeErr != nil {
				log.Printf("Warning: failed to write devcontainer build error log to %s: %v", errorLogPath, writeErr)
			}

			// Retry with the default config.
			usedFallback, fallbackErr := runDevcontainerWithDefault(ctx, cfg)
			if fallbackErr != nil {
				return false, fmt.Errorf("devcontainer fallback also failed: %w (original error: %v)", fallbackErr, err)
			}
			_ = usedFallback // always true here
			log.Printf("Devcontainer fallback succeeded with default image")
			return true, nil
		}

		return false, nil
	}

	// No config — use default.
	_, err := runDevcontainerWithDefault(ctx, cfg)
	if err != nil {
		return false, err
	}
	return false, nil
}

// runDevcontainerWithDefault writes a default devcontainer config and runs devcontainer up
// with --override-config and optional --additional-features.
func runDevcontainerWithDefault(ctx context.Context, cfg *config.Config) (bool, error) {
	configPath, err := writeDefaultDevcontainerConfig(cfg)
	if err != nil {
		return false, fmt.Errorf("failed to write default devcontainer config: %w", err)
	}
	log.Printf("Using default devcontainer config: %s (image: %s)", configPath, cfg.DefaultDevcontainerImage)

	args := []string{"up", "--workspace-folder", cfg.WorkspaceDir, "--override-config", configPath}
	if cfg.AdditionalFeatures != "" {
		log.Printf("Injecting additional devcontainer features: %s", cfg.AdditionalFeatures)
		args = append(args, "--additional-features", cfg.AdditionalFeatures)
	}

	cmd := exec.CommandContext(ctx, "devcontainer", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("devcontainer up failed: %w: %s", err, strings.TrimSpace(string(output)))
	}

	return true, nil
}

// writeDefaultDevcontainerConfig writes a default devcontainer.json to the configured
// path (DefaultDevcontainerConfigPath) and returns the path. The config uses the image
// specified by DefaultDevcontainerImage. This is only used when a repo has no devcontainer
// config of its own.
func writeDefaultDevcontainerConfig(cfg *config.Config) (string, error) {
	configPath := cfg.DefaultDevcontainerConfigPath
	if configPath == "" {
		configPath = config.DefaultDevcontainerConfigPath
	}

	// Create parent directory if needed
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		return "", fmt.Errorf("failed to create config directory: %w", err)
	}

	image := cfg.DefaultDevcontainerImage
	if image == "" {
		image = config.DefaultDevcontainerImage
	}

	configJSON := fmt.Sprintf(`{
  "name": "Default Workspace",
  "image": %q,
  "features": {
    "ghcr.io/devcontainers/features/git:1": {},
    "ghcr.io/devcontainers/features/github-cli:1": {}
  },
  "remoteUser": "vscode"
}
`, image)

	if err := os.WriteFile(configPath, []byte(configJSON), 0o644); err != nil {
		return "", fmt.Errorf("failed to write default config: %w", err)
	}

	return configPath, nil
}

// hasDevcontainerConfig checks whether the workspace directory contains a devcontainer
// configuration (either .devcontainer/devcontainer.json or .devcontainer.json).
// When present, we skip --additional-features to avoid conflicts with the repo's own setup.
func hasDevcontainerConfig(workspaceDir string) bool {
	candidates := []string{
		filepath.Join(workspaceDir, ".devcontainer", "devcontainer.json"),
		filepath.Join(workspaceDir, ".devcontainer.json"),
	}
	for _, path := range candidates {
		if _, err := os.Stat(path); err == nil {
			log.Printf("Found devcontainer config: %s", path)
			return true
		}
	}
	return false
}

// waitForCommand polls until the given command is available in PATH or ctx is cancelled.
func waitForCommand(ctx context.Context, name string) error {
	if _, err := exec.LookPath(name); err == nil {
		return nil // Already available
	}

	log.Printf("Waiting for %q to be installed (cloud-init may still be running)...", name)
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	logged := time.Now()
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("context cancelled while waiting for %q: %w", name, ctx.Err())
		case <-ticker.C:
			if _, err := exec.LookPath(name); err == nil {
				log.Printf("Command %q is now available", name)
				return nil
			}
			if time.Since(logged) >= 30*time.Second {
				log.Printf("Still waiting for %q to be installed...", name)
				logged = time.Now()
			}
		}
	}
}

func ensureGitCredentialHelper(ctx context.Context, cfg *config.Config) error {
	if cfg.Repository == "" {
		return nil
	}
	if !isGitHubRepo(cfg.Repository) {
		log.Printf("Repository %s is not a GitHub repository, skipping git credential helper setup", cfg.Repository)
		return nil
	}
	if cfg.CallbackToken == "" {
		return errors.New("callback token is required for git credential helper setup")
	}

	containerID, err := findDevcontainerID(ctx, cfg)
	if err != nil {
		return fmt.Errorf("failed to locate devcontainer for credential helper setup: %w", err)
	}

	script, err := renderGitCredentialHelperScript(cfg)
	if err != nil {
		return fmt.Errorf("failed to render git credential helper script: %w", err)
	}

	tempFile, err := os.CreateTemp("", "git-credential-sam-*")
	if err != nil {
		return fmt.Errorf("failed to create temporary credential helper script: %w", err)
	}
	tempPath := tempFile.Name()
	defer os.Remove(tempPath)

	if _, err := tempFile.WriteString(script); err != nil {
		_ = tempFile.Close()
		return fmt.Errorf("failed to write temporary credential helper script: %w", err)
	}
	if err := tempFile.Close(); err != nil {
		return fmt.Errorf("failed to finalize temporary credential helper script: %w", err)
	}

	if err := os.Chmod(tempPath, 0o755); err != nil {
		return fmt.Errorf("failed to chmod temporary credential helper script: %w", err)
	}

	installPath := "/usr/local/bin/git-credential-sam"
	cmd := exec.CommandContext(ctx, "docker", "cp", tempPath, containerID+":"+installPath)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to copy credential helper into devcontainer: %w: %s", err, strings.TrimSpace(string(output)))
	}

	// Use -u root because the container's default user (e.g. "node") may not have
	// write permissions to /usr/local/bin/.
	cmd = exec.CommandContext(ctx, "docker", "exec", "-u", "root", containerID, "chmod", "0755", installPath)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to chmod credential helper in devcontainer: %w: %s", err, strings.TrimSpace(string(output)))
	}

	if err := configureGitCredentialHelper(ctx, containerID, installPath); err != nil {
		return err
	}

	log.Printf("Configured git credential helper in devcontainer %s", containerID)
	return nil
}

func renderGitCredentialHelperScript(cfg *config.Config) (string, error) {
	if cfg == nil {
		return "", errors.New("nil config")
	}
	if cfg.CallbackToken == "" {
		return "", errors.New("callback token is empty")
	}
	if cfg.Port <= 0 {
		return "", fmt.Errorf("invalid VM agent port: %d", cfg.Port)
	}

	query := ""
	if workspaceID := strings.TrimSpace(cfg.WorkspaceID); workspaceID != "" {
		query = "?workspaceId=" + url.QueryEscape(workspaceID)
	}

	return fmt.Sprintf(`#!/bin/sh
set -eu

action="${1:-get}"
if [ "$action" != "get" ]; then
  exit 0
fi

requested_host=""
while IFS= read -r line; do
  [ -z "$line" ] && break
  case "$line" in
    host=*) requested_host="${line#host=}" ;;
  esac
done

if [ -n "$requested_host" ] && [ "$requested_host" != "github.com" ] && [ "$requested_host" != "api.github.com" ]; then
  exit 0
fi

resolve_gateway() {
  ip route 2>/dev/null | awk '/default/ {print $3; exit}'
}

request_credentials() {
  target="$1"
  curl -fsS --max-time 5 \
    -H "Authorization: Bearer %s" \
    "http://${target}:%d/git-credential%s"
}

gateway="$(resolve_gateway || true)"
for target in host.docker.internal "$gateway" 172.17.0.1; do
  [ -n "$target" ] || continue
  if request_credentials "$target" 2>/dev/null; then
    exit 0
  fi
done

exit 0
`, cfg.CallbackToken, cfg.Port, query), nil
}

func findDevcontainerID(ctx context.Context, cfg *config.Config) (string, error) {
	filter := fmt.Sprintf("label=%s=%s", cfg.ContainerLabelKey, cfg.ContainerLabelValue)
	cmd := exec.CommandContext(ctx, "docker", "ps", "-q", "--filter", filter)
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("docker ps failed: %w", err)
	}

	candidates := strings.Fields(string(output))
	if len(candidates) == 0 {
		return "", fmt.Errorf("no running devcontainer found for label %s=%s", cfg.ContainerLabelKey, cfg.ContainerLabelValue)
	}

	return candidates[0], nil
}

func configureGitCredentialHelper(ctx context.Context, containerID, helperPath string) error {
	// Use -u root because the container's default user (e.g. "node") may not have
	// write permissions to /etc/gitconfig (system-level git config).
	cmd := exec.CommandContext(
		ctx,
		"docker",
		"exec",
		"-u", "root",
		containerID,
		"git",
		"config",
		"--system",
		"credential.helper",
		helperPath,
	)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to configure git credential helper in devcontainer: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func resolveGitIdentity(state *bootstrapState) (name string, email string, ok bool) {
	if state == nil {
		return "", "", false
	}

	email = strings.TrimSpace(state.GitUserEmail)
	if email == "" {
		return "", "", false
	}

	name = strings.TrimSpace(state.GitUserName)
	if name != "" {
		return name, email, true
	}

	if at := strings.Index(email, "@"); at > 0 {
		return email[:at], email, true
	}
	return "workspace-user", email, true
}

func ensureGitIdentity(ctx context.Context, cfg *config.Config, state *bootstrapState) error {
	gitUserName, gitUserEmail, ok := resolveGitIdentity(state)
	if !ok {
		return nil
	}

	containerID, err := findDevcontainerID(ctx, cfg)
	if err != nil {
		return fmt.Errorf("failed to locate devcontainer for git identity setup: %w", err)
	}

	setEmailCmd := exec.CommandContext(
		ctx,
		"docker",
		"exec",
		"-u", "root",
		containerID,
		"git",
		"config",
		"--system",
		"user.email",
		gitUserEmail,
	)
	if output, err := setEmailCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to configure git user.email in devcontainer: %w: %s", err, strings.TrimSpace(string(output)))
	}

	setNameCmd := exec.CommandContext(
		ctx,
		"docker",
		"exec",
		"-u", "root",
		containerID,
		"git",
		"config",
		"--system",
		"user.name",
		gitUserName,
	)
	if output, err := setNameCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to configure git user.name in devcontainer: %w: %s", err, strings.TrimSpace(string(output)))
	}

	log.Printf("Configured git identity in devcontainer %s", containerID)
	return nil
}

func markWorkspaceReady(ctx context.Context, cfg *config.Config) error {
	endpoint := fmt.Sprintf("%s/api/workspaces/%s/ready", strings.TrimRight(cfg.ControlPlaneURL, "/"), cfg.WorkspaceID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader([]byte("{}")))
	if err != nil {
		return fmt.Errorf("failed to create ready request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.CallbackToken)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to call ready endpoint: %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 8*1024))
		return fmt.Errorf("ready endpoint returned HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
	}

	log.Printf("Workspace %s marked ready", cfg.WorkspaceID)
	return nil
}

func normalizeRepoURL(repo string) string {
	repo = strings.TrimSpace(repo)
	if strings.HasPrefix(repo, "http://") || strings.HasPrefix(repo, "https://") {
		if !strings.HasSuffix(repo, ".git") {
			return repo + ".git"
		}
		return repo
	}

	repo = strings.TrimPrefix(repo, "github.com/")
	repo = strings.TrimPrefix(repo, "https://github.com/")
	repo = strings.TrimPrefix(repo, "http://github.com/")
	repo = strings.TrimSuffix(repo, ".git")
	return "https://github.com/" + repo + ".git"
}

func withGitHubToken(repoURL, token string) (string, error) {
	if token == "" {
		return repoURL, nil
	}

	u, err := url.Parse(repoURL)
	if err != nil {
		return "", err
	}
	if u.Scheme != "https" || !strings.EqualFold(u.Host, "github.com") {
		return repoURL, nil
	}
	u.User = url.UserPassword("x-access-token", token)
	return u.String(), nil
}

func isGitHubRepo(repo string) bool {
	normalized := normalizeRepoURL(repo)
	u, err := url.Parse(normalized)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Host, "github.com")
}

func redactSecret(input, secret string) string {
	if secret == "" {
		return input
	}
	return strings.ReplaceAll(input, secret, "***")
}

func loadState(path string) (*bootstrapState, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}

	var state bootstrapState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	if state.WorkspaceID == "" || state.CallbackToken == "" {
		return nil, errors.New("bootstrap state is missing required fields")
	}
	return &state, nil
}

func saveState(path string, state *bootstrapState) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}

	encoded, err := json.Marshal(state)
	if err != nil {
		return err
	}

	return os.WriteFile(path, encoded, 0o600)
}
