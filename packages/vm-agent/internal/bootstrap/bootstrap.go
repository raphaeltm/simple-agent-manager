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
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/config"
)

const (
	maxBackoff = 30 * time.Second

	// volumePrefix is prepended to workspace IDs to form Docker named volume names.
	volumePrefix = "sam-ws-"

	buildErrorLogFilename = ".devcontainer-build-error.log"

	workspaceReadyStatusRunning  = "running"
	workspaceReadyStatusRecovery = "recovery"
)

// VolumeNameForWorkspace returns the Docker named volume name for a workspace.
// Exported so that workspace deletion can also remove the volume.
func VolumeNameForWorkspace(workspaceID string) string {
	return volumePrefix + workspaceID
}

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

	// Create a named Docker volume for container-mode workspaces.
	// The volume replaces the host bind-mount, eliminating permission issues.
	volumeName := ""
	if cfg.ContainerMode {
		reporter.Log("volume_create", "started", "Creating workspace volume")
		var volErr error
		volumeName, volErr = ensureVolumeReady(ctx, cfg.WorkspaceID)
		if volErr != nil {
			reporter.Log("volume_create", "failed", "Volume creation failed", volErr.Error())
			return volErr
		}
		reporter.Log("volume_create", "completed", "Workspace volume ready")
	}

	reporter.Log("git_clone", "started", "Cloning repository")
	if err := ensureRepositoryReady(ctx, cfg, state, volumeName); err != nil {
		reporter.Log("git_clone", "failed", "Repository clone failed", err.Error())
		return err
	}
	reporter.Log("git_clone", "completed", "Repository cloned")

	reporter.Log("devcontainer_wait", "started", "Waiting for devcontainer CLI")
	reporter.Log("devcontainer_up", "started", "Building devcontainer")
	usedFallback, err := ensureDevcontainerReady(ctx, cfg, volumeName)
	if err != nil {
		reporter.Log("devcontainer_up", "failed", "Devcontainer build failed", err.Error())
		return err
	}
	if usedFallback {
		reporter.Log("devcontainer_up", "completed", "Devcontainer ready (fallback to default image)")
	} else {
		reporter.Log("devcontainer_up", "completed", "Devcontainer ready")
	}

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

	reporter.Log("sam_env", "started", "Configuring SAM environment")
	if err := ensureSAMEnvironment(ctx, cfg, state.GitHubToken); err != nil {
		reporter.Log("sam_env", "failed", "SAM environment setup failed", err.Error())
		log.Printf("Warning: SAM environment setup failed (non-fatal): %v", err)
	} else {
		reporter.Log("sam_env", "completed", "SAM environment configured")
	}

	readyStatus := workspaceReadyStatusRunning
	if recovery, recoveryErr := hasBuildErrorMarker(cfg); recoveryErr != nil {
		log.Printf("Warning: failed to inspect build error marker for workspace %s: %v", cfg.WorkspaceID, recoveryErr)
	} else if recovery {
		readyStatus = workspaceReadyStatusRecovery
	}
	if usedFallback {
		readyStatus = workspaceReadyStatusRecovery
	}

	reporter.Log("workspace_ready", "started", "Marking workspace ready")
	if err := markWorkspaceReady(ctx, cfg, readyStatus); err != nil {
		reporter.Log("workspace_ready", "failed", "Failed to mark workspace ready", err.Error())
		return err
	}
	reporter.Log("workspace_ready", "completed", "Workspace is ready")

	return nil
}

// PrepareWorkspace provisions a workspace repository/devcontainer and configures
// git credentials/identity using the provided state. This is used by node-mode
// workspace creation where workspaces are prepared on demand rather than at VM boot.
// Returns (isRecoveryMode, error) where isRecoveryMode is true when provisioning
// left a devcontainer build error marker and the workspace should be reported as
// recovery mode instead of running.
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

	// Create a named Docker volume for container-mode workspaces.
	volumeName := ""
	if cfg.ContainerMode {
		var volErr error
		volumeName, volErr = ensureVolumeReady(ctx, cfg.WorkspaceID)
		if volErr != nil {
			return false, volErr
		}
	}

	if err := ensureRepositoryReady(ctx, cfg, bootstrap, volumeName); err != nil {
		return false, err
	}
	usedFallback, err := ensureDevcontainerReady(ctx, cfg, volumeName)
	if err != nil {
		return false, err
	}

	recoveryMode := usedFallback
	if markerFound, markerErr := hasBuildErrorMarker(cfg); markerErr != nil {
		log.Printf("Warning: failed to inspect build error marker for workspace %s: %v", cfg.WorkspaceID, markerErr)
	} else if markerFound {
		recoveryMode = true
	}

	if err := ensureGitCredentialHelper(ctx, cfg); err != nil {
		return recoveryMode, err
	}
	if err := ensureGitIdentity(ctx, cfg, bootstrap); err != nil {
		return recoveryMode, err
	}
	if err := ensureSAMEnvironment(ctx, cfg, bootstrap.GitHubToken); err != nil {
		log.Printf("Warning: SAM environment setup failed (non-fatal): %v", err)
	}

	readyStatus := workspaceReadyStatusRunning
	if recoveryMode {
		readyStatus = workspaceReadyStatusRecovery
	}
	if err := markWorkspaceReady(ctx, cfg, readyStatus); err != nil {
		return recoveryMode, err
	}

	return recoveryMode, nil
}

// ensureVolumeReady creates a Docker named volume for the workspace if it doesn't
// already exist. The volume persists across container rebuilds and is deleted when
// the workspace is deleted.
func ensureVolumeReady(ctx context.Context, workspaceID string) (string, error) {
	volumeName := VolumeNameForWorkspace(workspaceID)

	// docker volume create is idempotent — returns the volume name if it already exists.
	cmd := exec.CommandContext(ctx, "docker", "volume", "create", volumeName)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("failed to create Docker volume %s: %w: %s", volumeName, err, strings.TrimSpace(string(output)))
	}

	log.Printf("Docker volume ready: %s", volumeName)
	return volumeName, nil
}

// RemoveVolume removes the Docker named volume for a workspace. It is safe to call
// even if the volume doesn't exist. Exported for use by workspace deletion.
func RemoveVolume(ctx context.Context, workspaceID string) error {
	volumeName := VolumeNameForWorkspace(workspaceID)
	cmd := exec.CommandContext(ctx, "docker", "volume", "rm", "-f", volumeName)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to remove Docker volume %s: %w: %s", volumeName, err, strings.TrimSpace(string(output)))
	}
	log.Printf("Docker volume removed: %s", volumeName)
	return nil
}

func buildErrorLogPath(workspaceDir string) string {
	return filepath.Join(workspaceDir, buildErrorLogFilename)
}

func hasBuildErrorMarker(cfg *config.Config) (bool, error) {
	errorLogPath := buildErrorLogPath(cfg.WorkspaceDir)
	if _, err := os.Stat(errorLogPath); err == nil {
		return true, nil
	} else if !os.IsNotExist(err) {
		return false, fmt.Errorf("failed to stat build error marker %s: %w", errorLogPath, err)
	}
	return false, nil
}

func writeBuildErrorToHost(workspaceDir string, output []byte) error {
	errorLogPath := buildErrorLogPath(workspaceDir)
	if err := os.WriteFile(errorLogPath, output, 0o644); err != nil {
		return fmt.Errorf("failed to write devcontainer build error log to %s: %w", errorLogPath, err)
	}
	return nil
}

// writeBuildErrorToVolume writes the devcontainer build error log into the Docker
// volume so it is visible from inside the fallback container. The host workspace
// directory is not mounted into the fallback container, so errors written there
// are invisible to users.
func writeBuildErrorToVolume(ctx context.Context, volumeName string, output []byte) error {
	cmd := exec.CommandContext(ctx, "docker", "run", "--rm",
		"-v", volumeName+":/workspaces",
		"-i", "alpine:latest",
		"sh", "-c", "cat > /workspaces/"+buildErrorLogFilename,
	)
	cmd.Stdin = bytes.NewReader(output)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to write devcontainer build error log to volume %s: %w: %s", volumeName, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func persistBuildErrorArtifacts(ctx context.Context, cfg *config.Config, volumeName string, output []byte) error {
	if err := writeBuildErrorToHost(cfg.WorkspaceDir, output); err != nil {
		return err
	}
	if volumeName != "" {
		if err := writeBuildErrorToVolume(ctx, volumeName, output); err != nil {
			return err
		}
	}
	return nil
}

func clearBuildErrorArtifacts(ctx context.Context, cfg *config.Config, volumeName string) {
	errorLogPath := buildErrorLogPath(cfg.WorkspaceDir)
	if err := os.Remove(errorLogPath); err != nil && !os.IsNotExist(err) {
		log.Printf("Warning: failed to remove build error marker %s: %v", errorLogPath, err)
	}

	if volumeName == "" {
		return
	}

	cmd := exec.CommandContext(ctx, "docker", "run", "--rm",
		"-v", volumeName+":/workspaces",
		"alpine:latest",
		"rm", "-f", "/workspaces/"+buildErrorLogFilename,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		log.Printf("Warning: failed to remove build error marker from volume %s: %v: %s", volumeName, err, strings.TrimSpace(string(out)))
	}
}

func ensureVolumeWritable(ctx context.Context, volumeName string) error {
	if strings.TrimSpace(volumeName) == "" {
		return nil
	}

	cmd := exec.CommandContext(
		ctx,
		"docker",
		"run",
		"--rm",
		"-v", volumeName+":/workspaces",
		"alpine:latest",
		"sh", "-c", "chmod -R a+rwX /workspaces",
	)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to chmod workspace volume %s: %w: %s", volumeName, err, strings.TrimSpace(string(output)))
	}
	log.Printf("Adjusted permissions in volume %s", volumeName)
	return nil
}

// populateVolumeFromHost copies the host-cloned repository into a Docker named
// volume using a lightweight throwaway container. The host clone is needed for
// devcontainer CLI config discovery (it reads .devcontainer/ from the host), while
// the volume copy is what the container actually uses at runtime.
func populateVolumeFromHost(ctx context.Context, hostPath, volumeName, repoDirName string) error {
	targetPath := "/workspaces/" + repoDirName

	// Check if the volume already has the repo (idempotent).
	checkArgs := []string{
		"run", "--rm",
		"-v", volumeName + ":/workspaces",
		"alpine:latest",
		"test", "-d", targetPath + "/.git",
	}
	checkCmd := exec.CommandContext(ctx, "docker", checkArgs...)
	if err := checkCmd.Run(); err == nil {
		log.Printf("Volume %s already has repository at %s, skipping populate", volumeName, targetPath)
		return ensureVolumeWritable(ctx, volumeName)
	}

	// Copy the host clone into the volume. Bind-mount the host path read-only
	// and the volume read-write, then use cp to transfer.
	copyArgs := []string{
		"run", "--rm",
		"-v", hostPath + ":/src:ro",
		"-v", volumeName + ":/workspaces",
		"alpine:latest",
		"sh", "-c", fmt.Sprintf("cp -a /src %s", targetPath),
	}
	log.Printf("Populating volume %s at %s from host clone %s", volumeName, targetPath, hostPath)
	cmd := exec.CommandContext(ctx, "docker", copyArgs...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to populate volume from host clone: %w: %s", err, strings.TrimSpace(string(output)))
	}

	if err := ensureVolumeWritable(ctx, volumeName); err != nil {
		return err
	}

	log.Printf("Volume %s populated at %s", volumeName, targetPath)
	return nil
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

func ensureRepositoryReady(ctx context.Context, cfg *config.Config, state *bootstrapState, volumeName string) error {
	if cfg.Repository == "" {
		log.Printf("Repository is empty, skipping clone step")
		return nil
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

	repoDirName := config.DeriveRepoDirName(cfg.Repository)
	if repoDirName == "" {
		repoDirName = "workspace"
	}

	// Always clone to the host filesystem. The devcontainer CLI needs the project
	// on the host to discover .devcontainer/ configs and resolve Dockerfile paths.
	gitDir := filepath.Join(cfg.WorkspaceDir, ".git")
	if _, err := os.Stat(gitDir); err == nil {
		log.Printf("Repository already present at %s, skipping clone", cfg.WorkspaceDir)
	} else {
		if err := os.MkdirAll(filepath.Dir(cfg.WorkspaceDir), 0o755); err != nil {
			return fmt.Errorf("failed to create workspace parent directory: %w", err)
		}

		if err := os.RemoveAll(cfg.WorkspaceDir); err != nil {
			return fmt.Errorf("failed to clean workspace directory: %w", err)
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
	}

	// When using a Docker volume, populate it from the host clone. The host clone
	// stays for devcontainer CLI config discovery; the volume copy is what the
	// container actually uses at runtime (no bind-mount permission issues).
	if volumeName != "" {
		return populateVolumeFromHost(ctx, cfg.WorkspaceDir, volumeName, repoDirName)
	}

	return nil
}

// ensureDevcontainerReady builds and starts the devcontainer for the workspace.
// It returns (usedFallback, error) where usedFallback is true if the repo's own
// devcontainer config failed and the default image was used instead.
//
// When volumeName is non-empty, the devcontainer is started with a named Docker
// volume mounted at /workspaces instead of the default bind mount. This eliminates
// host/container permission mismatches because the container user owns everything
// inside the volume.
func ensureDevcontainerReady(ctx context.Context, cfg *config.Config, volumeName string) (bool, error) {
	if _, err := findDevcontainerID(ctx, cfg); err == nil {
		log.Printf("Devcontainer already running for %s=%s", cfg.ContainerLabelKey, cfg.ContainerLabelValue)
		ensureContainerUserResolved(ctx, cfg)
		if err := ensureWorkspaceOwnership(ctx, cfg); err != nil {
			return false, err
		}
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
	usedFallback := false

	if hasConfig {
		// Try with repo's own devcontainer config first.
		// When using a volume, resolve the repo config through `devcontainer
		// read-configuration` and inject workspaceMount/workspaceFolder into the
		// merged config so required fields (image/dockerFile/dockerComposeFile)
		// remain intact.
		var overridePath string
		if volumeName != "" {
			var mountErr error
			overridePath, mountErr = writeMountOverrideConfig(ctx, cfg, volumeName)
			if mountErr != nil {
				log.Printf("Failed to prepare repo mount override config, falling back to default image: %v", mountErr)
				fallbackOutput := []byte(fmt.Sprintf("failed to prepare repo devcontainer mount override: %v\n", mountErr))
				var fallbackErr error
				usedFallback, fallbackErr = fallbackToDefaultDevcontainer(ctx, cfg, volumeName, mountErr, fallbackOutput)
				if fallbackErr != nil {
					return false, fallbackErr
				}
			}
			defer os.Remove(overridePath)
		}

		if !usedFallback {
			args := devcontainerUpArgs(cfg, overridePath)
			if cfg.AdditionalFeatures != "" {
				log.Printf("Repo has its own devcontainer config — skipping additional-features injection")
			}

			cmd := exec.CommandContext(ctx, "devcontainer", args...)
			output, err := cmd.CombinedOutput()
			if err != nil {
				// Repo config failed — log the error and fall back to default image.
				log.Printf("Devcontainer build failed with repo config, falling back to default image: %v: %s", err, strings.TrimSpace(string(output)))
				var fallbackErr error
				usedFallback, fallbackErr = fallbackToDefaultDevcontainer(ctx, cfg, volumeName, err, output)
				if fallbackErr != nil {
					return false, fallbackErr
				}
			}
		}
	} else {
		// No config — use default.
		_, err := runDevcontainerWithDefault(ctx, cfg, volumeName)
		if err != nil {
			return false, err
		}
	}

	if !usedFallback {
		clearBuildErrorArtifacts(ctx, cfg, volumeName)
	}
	ensureContainerUserResolved(ctx, cfg)
	if err := ensureWorkspaceOwnership(ctx, cfg); err != nil {
		return false, err
	}
	return usedFallback, nil
}

func fallbackToDefaultDevcontainer(
	ctx context.Context,
	cfg *config.Config,
	volumeName string,
	originalErr error,
	output []byte,
) (bool, error) {
	if len(bytes.TrimSpace(output)) == 0 {
		output = []byte(fmt.Sprintf("devcontainer setup failed: %v\n", originalErr))
	}

	// Never start fallback if we cannot persist error artifacts first.
	// This guarantees recovery containers always have diagnostics attached.
	if err := persistBuildErrorArtifacts(ctx, cfg, volumeName, output); err != nil {
		return false, fmt.Errorf("failed to persist devcontainer build logs; aborting fallback: %w (original error: %v)", err, originalErr)
	}

	// Remove the stale container left by the failed first attempt.
	// Without this, devcontainer up --override-config can reuse the existing
	// broken container instead of creating a new one from the fallback image.
	removeStaleContainers(ctx, cfg)

	if _, err := runDevcontainerWithDefault(ctx, cfg, volumeName); err != nil {
		return false, fmt.Errorf("devcontainer fallback also failed: %w (original error: %v)", err, originalErr)
	}

	log.Printf("Devcontainer fallback succeeded with default image")
	return true, nil
}

// devcontainerUpArgs builds the argument slice for `devcontainer up`.
// When overrideConfigPath is non-empty, it adds --override-config.
// Volume mount settings are injected via the workspaceMount property in the
// override config (NOT via the --mount CLI flag, which only adds supplementary
// mounts and does not replace the default workspace bind mount).
func devcontainerUpArgs(cfg *config.Config, overrideConfigPath string) []string {
	args := []string{"up", "--workspace-folder", cfg.WorkspaceDir}

	if overrideConfigPath != "" {
		args = append(args, "--override-config", overrideConfigPath)
	}

	return args
}

type devcontainerReadConfigurationResult struct {
	Outcome             string                 `json:"outcome"`
	Message             string                 `json:"message"`
	Description         string                 `json:"description"`
	MergedConfiguration map[string]interface{} `json:"mergedConfiguration"`
}

func hasReadConfigurationPayloadData(payload *devcontainerReadConfigurationResult) bool {
	if payload == nil {
		return false
	}

	return payload.Outcome != "" ||
		payload.Message != "" ||
		payload.Description != "" ||
		len(payload.MergedConfiguration) > 0
}

func parseReadConfigurationCandidate(candidate string) (*devcontainerReadConfigurationResult, bool) {
	var payload devcontainerReadConfigurationResult
	decoder := json.NewDecoder(strings.NewReader(candidate))
	if err := decoder.Decode(&payload); err != nil {
		return nil, false
	}

	if !hasReadConfigurationPayloadData(&payload) {
		return nil, false
	}

	return &payload, true
}

func parseDevcontainerReadConfigurationOutput(output string) (*devcontainerReadConfigurationResult, error) {
	trimmed := strings.TrimSpace(output)
	if trimmed == "" {
		return nil, errors.New("empty read-configuration output")
	}

	// read-configuration output can include mixed logs + JSON payload and may
	// include JSON log lines that are not the final result. Scan from the end
	// and pick the latest payload that includes mergedConfiguration when possible.
	var fallback *devcontainerReadConfigurationResult
	for i := len(trimmed) - 1; i >= 0; i-- {
		if trimmed[i] != '{' {
			continue
		}

		payload, ok := parseReadConfigurationCandidate(trimmed[i:])
		if !ok {
			continue
		}
		if len(payload.MergedConfiguration) > 0 {
			return payload, nil
		}
		if fallback == nil {
			fallback = payload
		}
	}
	if fallback != nil {
		return fallback, nil
	}

	return nil, fmt.Errorf("unable to parse read-configuration JSON output: %s", trimmed)
}

func hasMergedRuntimeSource(merged map[string]interface{}) bool {
	if len(merged) == 0 {
		return false
	}

	for _, key := range []string{"image", "dockerFile", "dockerComposeFile"} {
		value, ok := merged[key]
		if !ok {
			continue
		}
		switch v := value.(type) {
		case string:
			if strings.TrimSpace(v) != "" {
				return true
			}
		case []interface{}:
			if len(v) > 0 {
				return true
			}
		}
	}

	return false
}

func normalizeMergedLifecycleCommands(merged map[string]interface{}) {
	if len(merged) == 0 {
		return
	}

	// read-configuration returns normalized lifecycle command arrays under
	// plural keys. devcontainer up expects the singular schema keys.
	keyMap := map[string]string{
		"onCreateCommands":      "onCreateCommand",
		"updateContentCommands": "updateContentCommand",
		"postCreateCommands":    "postCreateCommand",
		"postStartCommands":     "postStartCommand",
		"postAttachCommands":    "postAttachCommand",
	}

	for pluralKey, singularKey := range keyMap {
		value, ok := merged[pluralKey]
		if !ok {
			continue
		}
		if _, hasSingular := merged[singularKey]; !hasSingular {
			merged[singularKey] = normalizeLifecycleCommandValue(value)
		}
		delete(merged, pluralKey)
	}
}

func normalizeLifecycleCommandValue(value interface{}) interface{} {
	commands, ok := value.([]interface{})
	if !ok {
		return value
	}

	parts := make([]string, 0, len(commands))
	for _, command := range commands {
		str, ok := command.(string)
		if !ok {
			return value
		}
		trimmed := strings.TrimSpace(str)
		if trimmed == "" {
			continue
		}
		parts = append(parts, trimmed)
	}

	switch len(parts) {
	case 0:
		return ""
	case 1:
		return parts[0]
	default:
		return strings.Join(parts, " && ")
	}
}

func runReadConfiguration(ctx context.Context, workspaceDir string) (*devcontainerReadConfigurationResult, error) {
	args := []string{
		"read-configuration",
		"--workspace-folder", workspaceDir,
		"--include-merged-configuration",
	}
	cmd := exec.CommandContext(ctx, "devcontainer", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("devcontainer read-configuration failed: %w: %s", err, strings.TrimSpace(string(output)))
	}

	readResult, err := parseDevcontainerReadConfigurationOutput(string(output))
	if err != nil {
		return nil, fmt.Errorf("failed to parse devcontainer read-configuration output: %w", err)
	}
	if strings.TrimSpace(readResult.Outcome) != "" && readResult.Outcome != "success" {
		return nil, fmt.Errorf("devcontainer read-configuration returned %q: %s %s", readResult.Outcome, readResult.Message, readResult.Description)
	}

	return readResult, nil
}

func extractContainerUserFromMergedConfiguration(merged map[string]interface{}) string {
	for _, key := range []string{"remoteUser", "containerUser"} {
		value, ok := merged[key]
		if !ok {
			continue
		}
		asString, ok := value.(string)
		if !ok {
			continue
		}
		if trimmed := strings.TrimSpace(asString); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func extractContainerUserFromMetadataLabel(raw string) string {
	var entries []map[string]interface{}
	if err := json.Unmarshal([]byte(strings.TrimSpace(raw)), &entries); err != nil {
		return ""
	}

	resolved := ""
	for _, entry := range entries {
		for _, key := range []string{"remoteUser", "containerUser"} {
			value, ok := entry[key]
			if !ok {
				continue
			}
			asString, ok := value.(string)
			if !ok {
				continue
			}
			if trimmed := strings.TrimSpace(asString); trimmed != "" {
				// Keep the last value in metadata order (later entries are more specific).
				resolved = trimmed
			}
		}
	}
	return resolved
}

func detectContainerUserFromReadConfiguration(ctx context.Context, cfg *config.Config) string {
	readResult, err := runReadConfiguration(ctx, cfg.WorkspaceDir)
	if err != nil {
		log.Printf("Container user detection: read-configuration unavailable: %v", err)
		return ""
	}

	user := extractContainerUserFromMergedConfiguration(readResult.MergedConfiguration)
	if user == "" {
		log.Printf("Container user detection: read-configuration returned no remote/container user")
	}
	return user
}

func detectContainerUserFromMetadata(ctx context.Context, cfg *config.Config) string {
	containerID, err := findDevcontainerID(ctx, cfg)
	if err != nil {
		log.Printf("Container user detection: failed to resolve running container for metadata lookup: %v", err)
		return ""
	}

	cmd := exec.CommandContext(
		ctx,
		"docker",
		"inspect",
		"--format",
		"{{json (index .Config.Labels \"devcontainer.metadata\")}}",
		containerID,
	)
	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("Container user detection: docker inspect metadata failed: %v: %s", err, strings.TrimSpace(string(output)))
		return ""
	}

	var encoded *string
	if err := json.Unmarshal(bytes.TrimSpace(output), &encoded); err != nil {
		log.Printf("Container user detection: failed to decode metadata label payload: %v", err)
		return ""
	}
	if encoded == nil || strings.TrimSpace(*encoded) == "" {
		return ""
	}

	return extractContainerUserFromMetadataLabel(*encoded)
}

func detectContainerUserFromExec(ctx context.Context, cfg *config.Config) string {
	containerID, err := findDevcontainerID(ctx, cfg)
	if err != nil {
		log.Printf("Container user detection: failed to resolve running container for exec fallback: %v", err)
		return ""
	}

	cmd := exec.CommandContext(ctx, "docker", "exec", containerID, "id", "-un")
	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("Container user detection: docker exec id fallback failed: %v: %s", err, strings.TrimSpace(string(output)))
		return ""
	}

	return strings.TrimSpace(string(output))
}

func ensureContainerUserResolved(ctx context.Context, cfg *config.Config) {
	override := strings.TrimSpace(cfg.ContainerUser)
	if override != "" {
		log.Printf("Container user override active via CONTAINER_USER=%q", override)
		cfg.ContainerUser = override
		return
	}

	if detected := detectContainerUserFromReadConfiguration(ctx, cfg); detected != "" {
		cfg.ContainerUser = detected
		if detected == "root" {
			log.Printf("Warning: detected devcontainer user is root (source=read-configuration)")
		} else {
			log.Printf("Detected devcontainer user %q via read-configuration", detected)
		}
		return
	}
	if detected := detectContainerUserFromMetadata(ctx, cfg); detected != "" {
		cfg.ContainerUser = detected
		if detected == "root" {
			log.Printf("Warning: detected devcontainer user is root (source=devcontainer.metadata)")
		} else {
			log.Printf("Detected devcontainer user %q via devcontainer.metadata", detected)
		}
		return
	}
	if detected := detectContainerUserFromExec(ctx, cfg); detected != "" {
		cfg.ContainerUser = detected
		if detected == "root" {
			log.Printf("Warning: detected devcontainer user is root (source=docker exec id -un fallback)")
		} else {
			log.Printf("Detected devcontainer user %q via docker exec fallback", detected)
		}
		return
	}

	log.Printf("Warning: unable to detect devcontainer user; docker exec will use container default user")
}

func ensureWorkspaceOwnership(ctx context.Context, cfg *config.Config) error {
	if cfg == nil {
		return nil
	}

	user := strings.TrimSpace(cfg.ContainerUser)
	if user == "" || user == "root" {
		return nil
	}

	containerID, err := findDevcontainerID(ctx, cfg)
	if err != nil {
		return fmt.Errorf("failed to locate devcontainer for workspace ownership: %w", err)
	}

	uid, err := resolveContainerUserID(ctx, containerID, user, "-u", "uid")
	if err != nil {
		return err
	}
	gid, err := resolveContainerUserID(ctx, containerID, user, "-g", "gid")
	if err != nil {
		return err
	}

	ownerUID, ownerGID, err := statContainerPathOwnership(ctx, containerID, "/workspaces")
	if err != nil {
		return err
	}
	if ownerUID == uid && ownerGID == gid {
		log.Printf("Workspace ownership already set for %s (uid=%s gid=%s)", user, uid, gid)
		return nil
	}

	cmd := exec.CommandContext(ctx, "docker", "exec", "-u", "root", containerID, "chown", "-R", uid+":"+gid, "/workspaces")
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to chown /workspaces to %s (%s:%s): %w: %s", user, uid, gid, err, strings.TrimSpace(string(output)))
	}
	log.Printf("Adjusted /workspaces ownership to %s (%s:%s)", user, uid, gid)
	return nil
}

func resolveContainerUserID(ctx context.Context, containerID, user, flag, label string) (string, error) {
	cmd := exec.CommandContext(ctx, "docker", "exec", "-u", "root", containerID, "id", flag, user)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("failed to resolve %s for user %s: %w: %s", label, user, err, strings.TrimSpace(string(output)))
	}

	return parseNumericID(fmt.Sprintf("%s for user %s", label, user), string(output))
}

func parseNumericID(label, value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", fmt.Errorf("%s is empty", label)
	}
	for _, ch := range trimmed {
		if ch < '0' || ch > '9' {
			return "", fmt.Errorf("%s is not numeric: %q", label, trimmed)
		}
	}
	return trimmed, nil
}

func statContainerPathOwnership(ctx context.Context, containerID, path string) (string, string, error) {
	cmd := exec.CommandContext(ctx, "docker", "exec", "-u", "root", containerID, "stat", "-c", "%u:%g", path)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", "", fmt.Errorf("failed to stat %s ownership: %w: %s", path, err, strings.TrimSpace(string(output)))
	}

	parts := strings.Split(strings.TrimSpace(string(output)), ":")
	if len(parts) != 2 {
		return "", "", fmt.Errorf("unexpected stat output for %s: %q", path, strings.TrimSpace(string(output)))
	}
	uid, err := parseNumericID("uid for "+path, parts[0])
	if err != nil {
		return "", "", err
	}
	gid, err := parseNumericID("gid for "+path, parts[1])
	if err != nil {
		return "", "", err
	}
	return uid, gid, nil
}

// writeMountOverrideConfig resolves the repo devcontainer configuration via
// `devcontainer read-configuration` and writes a full override config that
// includes workspaceMount/workspaceFolder for named-volume workspaces.
func writeMountOverrideConfig(ctx context.Context, cfg *config.Config, volumeName string) (string, error) {
	repoDirName := config.DeriveRepoDirName(cfg.Repository)
	if repoDirName == "" {
		repoDirName = filepath.Base(cfg.WorkspaceDir)
	}

	readResult, err := runReadConfiguration(ctx, cfg.WorkspaceDir)
	if err != nil {
		return "", err
	}
	if len(readResult.MergedConfiguration) == 0 {
		return "", errors.New("devcontainer read-configuration returned empty mergedConfiguration")
	}
	if !hasMergedRuntimeSource(readResult.MergedConfiguration) {
		return "", errors.New("devcontainer read-configuration mergedConfiguration missing image/dockerFile/dockerComposeFile")
	}

	normalizeMergedLifecycleCommands(readResult.MergedConfiguration)
	readResult.MergedConfiguration["workspaceMount"] = fmt.Sprintf("source=%s,target=/workspaces,type=volume", volumeName)
	readResult.MergedConfiguration["workspaceFolder"] = fmt.Sprintf("/workspaces/%s", repoDirName)

	configJSON, err := json.MarshalIndent(readResult.MergedConfiguration, "", "  ")
	if err != nil {
		return "", fmt.Errorf("failed to marshal merged mount override config: %w", err)
	}
	configJSON = append(configJSON, '\n')

	tmpFile, err := os.CreateTemp("", "devcontainer-mount-override-*.json")
	if err != nil {
		return "", fmt.Errorf("failed to create mount override config: %w", err)
	}

	if _, err := tmpFile.Write(configJSON); err != nil {
		_ = tmpFile.Close()
		os.Remove(tmpFile.Name())
		return "", fmt.Errorf("failed to write mount override config: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		os.Remove(tmpFile.Name())
		return "", fmt.Errorf("failed to finalize mount override config: %w", err)
	}

	log.Printf("Wrote mount override config: %s (volume=%s, workspaceFolder=/workspaces/%s)", tmpFile.Name(), volumeName, repoDirName)
	return tmpFile.Name(), nil
}

// runDevcontainerWithDefault writes a default devcontainer config and runs devcontainer up
// with --override-config and optional --additional-features.
func runDevcontainerWithDefault(ctx context.Context, cfg *config.Config, volumeName string) (bool, error) {
	configPath, err := writeDefaultDevcontainerConfig(cfg, volumeName)
	if err != nil {
		return false, fmt.Errorf("failed to write default devcontainer config: %w", err)
	}
	log.Printf("Using default devcontainer config: %s (image: %s)", configPath, cfg.DefaultDevcontainerImage)

	args := devcontainerUpArgs(cfg, configPath)
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

// removeStaleContainers finds and removes any containers (running or stopped)
// matching the workspace label. This is used before the fallback devcontainer
// build to ensure a clean slate — without it, devcontainer up may reuse a
// broken container from a failed first attempt.
func removeStaleContainers(ctx context.Context, cfg *config.Config) {
	filter := fmt.Sprintf("label=%s=%s", cfg.ContainerLabelKey, cfg.ContainerLabelValue)
	// Use -a to find containers in ANY state (running, stopped, created, exited).
	cmd := exec.CommandContext(ctx, "docker", "ps", "-aq", "--filter", filter)
	output, err := cmd.Output()
	if err != nil {
		log.Printf("Warning: failed to list stale containers for cleanup: %v", err)
		return
	}

	containers := strings.Fields(string(output))
	for _, id := range containers {
		log.Printf("Removing stale container %s before fallback", id)
		rmCmd := exec.CommandContext(ctx, "docker", "rm", "-f", id)
		if rmOutput, rmErr := rmCmd.CombinedOutput(); rmErr != nil {
			log.Printf("Warning: failed to remove stale container %s: %v: %s", id, rmErr, strings.TrimSpace(string(rmOutput)))
		}
	}
}

// writeDefaultDevcontainerConfig writes a default devcontainer.json to the configured
// path (DefaultDevcontainerConfigPath) and returns the path. The config uses the image
// specified by DefaultDevcontainerImage. This is only used when a repo has no devcontainer
// config of its own.
//
// When volumeName is non-empty, the config includes workspaceMount and workspaceFolder
// to replace the default bind mount with a named Docker volume.
//
// The remoteUser field is only included when DefaultDevcontainerRemoteUser is explicitly
// set. When omitted, the container runs as the image's default USER (e.g., "vscode" for
// Microsoft devcontainer images), which is the correct behavior for most images.
func writeDefaultDevcontainerConfig(cfg *config.Config, volumeName string) (string, error) {
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

	remoteUserLine := ""
	if user := strings.TrimSpace(cfg.DefaultDevcontainerRemoteUser); user != "" {
		remoteUserLine = fmt.Sprintf(",\n  \"remoteUser\": %q", user)
	}

	// When using a named volume, inject workspaceMount and workspaceFolder to
	// replace the default bind mount. The devcontainer CLI's --mount flag only
	// adds supplementary mounts; workspaceMount in the config is the correct way
	// to override the default workspace mount.
	mountLines := ""
	if volumeName != "" {
		repoDirName := config.DeriveRepoDirName(cfg.Repository)
		if repoDirName == "" {
			repoDirName = filepath.Base(cfg.WorkspaceDir)
		}
		mountLines = fmt.Sprintf(",\n  \"workspaceMount\": \"source=%s,target=/workspaces,type=volume\",\n  \"workspaceFolder\": \"/workspaces/%s\"", volumeName, repoDirName)
	}

	configJSON := fmt.Sprintf(`{
  "name": "Default Workspace",
  "image": %q,
  "features": {
    "ghcr.io/devcontainers/features/git:1": {},
    "ghcr.io/devcontainers/features/github-cli:1": {}
  }%s%s
}
`, image, remoteUserLine, mountLines)

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
		if state == nil {
			log.Printf("Warning: git identity skipped — bootstrap state is nil")
		} else {
			log.Printf("Warning: git identity skipped — received name=%q email=%q (email is required)", state.GitUserName, state.GitUserEmail)
		}
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

	log.Printf("Configured git identity in devcontainer %s: name=%q email=%q", containerID, gitUserName, gitUserEmail)
	return nil
}

// buildSAMEnvScript generates a shell script that exports SAM platform metadata
// as environment variables. Only non-empty values are included.
// When githubToken is non-empty, it is exported as GITHUB_TOKEN so that the
// gh CLI and other GitHub API consumers work out of the box.
func buildSAMEnvScript(cfg *config.Config, githubToken string) string {
	baseDomain := config.DeriveBaseDomain(cfg.ControlPlaneURL)

	type envEntry struct {
		key, value string
	}
	entries := []envEntry{
		{"GITHUB_TOKEN", strings.TrimSpace(githubToken)},
		{"SAM_API_URL", strings.TrimRight(cfg.ControlPlaneURL, "/")},
		{"SAM_BRANCH", cfg.Branch},
		{"SAM_NODE_ID", cfg.NodeID},
		{"SAM_REPOSITORY", cfg.Repository},
		{"SAM_WORKSPACE_ID", cfg.WorkspaceID},
	}
	if baseDomain != "" && cfg.WorkspaceID != "" {
		entries = append(entries, envEntry{"SAM_WORKSPACE_URL", fmt.Sprintf("https://ws-%s.%s", cfg.WorkspaceID, baseDomain)})
	}

	var sb strings.Builder
	sb.WriteString("# SAM workspace environment variables (auto-generated)\n")
	for _, e := range entries {
		if e.value != "" {
			sb.WriteString(fmt.Sprintf("export %s=%q\n", e.key, e.value))
		}
	}
	return sb.String()
}

// ensureSAMEnvironment injects SAM platform metadata as environment variables into
// the devcontainer. Variables are written to /etc/profile.d/sam-env.sh (sourced by
// login/interactive shells) and /etc/sam/env (for non-shell consumers).
// When githubToken is non-empty, it is exported as GITHUB_TOKEN for gh CLI usage.
func ensureSAMEnvironment(ctx context.Context, cfg *config.Config, githubToken string) error {
	containerID, err := findDevcontainerID(ctx, cfg)
	if err != nil {
		return fmt.Errorf("failed to locate devcontainer for SAM environment setup: %w", err)
	}

	script := buildSAMEnvScript(cfg, githubToken)

	// Write to /etc/profile.d/sam-env.sh (sourced by login shells) and /etc/sam/env (parseable).
	writeCmd := exec.CommandContext(
		ctx, "docker", "exec", "-u", "root", containerID,
		"sh", "-c", "mkdir -p /etc/sam && cat > /etc/profile.d/sam-env.sh && cp /etc/profile.d/sam-env.sh /etc/sam/env",
	)
	writeCmd.Stdin = strings.NewReader(script)
	if output, err := writeCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to write SAM environment files: %w: %s", err, strings.TrimSpace(string(output)))
	}

	log.Printf("Configured SAM environment in devcontainer %s", containerID)
	return nil
}

type readyRequestBody struct {
	Status string `json:"status"`
}

func markWorkspaceReady(ctx context.Context, cfg *config.Config, status string) error {
	if status == "" {
		status = workspaceReadyStatusRunning
	}

	body, err := json.Marshal(readyRequestBody{Status: status})
	if err != nil {
		return fmt.Errorf("failed to encode ready request body: %w", err)
	}

	endpoint := fmt.Sprintf("%s/api/workspaces/%s/ready", strings.TrimRight(cfg.ControlPlaneURL, "/"), cfg.WorkspaceID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
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

	log.Printf("Workspace %s marked ready (%s)", cfg.WorkspaceID, status)
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
