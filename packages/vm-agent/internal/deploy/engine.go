package deploy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/workspace/vm-agent/internal/cache"
)

// Engine manages the deployment lifecycle: reconcile, apply, revert, observe.
type Engine struct {
	disk *DiskState
	cfg  EngineConfig

	verifierMu sync.RWMutex
	verifier   *Verifier

	// Callback token is rotated by the heartbeat goroutine via SetCallbackToken
	// while fetchRelease (running on the apply goroutine) reads it. Guard it with
	// its own mutex to avoid a data race on concurrent rotate/read.
	tokenMu       sync.RWMutex
	callbackToken string

	// Apply mutex: only one apply at a time. Use TryLock() to reject concurrent applies.
	applyMu sync.Mutex

	// Observed state (thread-safe reads)
	observedMu sync.RWMutex
	observed   ObservedState
}

// DockerLoginFunc is the signature for authenticating to a container registry.
type DockerLoginFunc func(ctx context.Context, registry, username, password string) error

// EngineConfig holds the configuration for the deploy engine.
type EngineConfig struct {
	EnvironmentID      string
	NodeID             string
	ControlPlaneURL    string
	CallbackToken      string
	ComposeCmd         string // e.g., "docker compose"
	ComposeProjectName string
	CaddyfilePath      string
	CaddyReloadCmd     string
	CaddyRestartCmd    string
	ACMEEmail          string // Contact email for the ACME global options block (optional)
	ACMECA             string // ACME CA directory URL override, e.g. LE staging (optional)
	CaddyReadyTimeout  time.Duration
	CaddyReadyInterval time.Duration
	HealthTimeout      time.Duration
	HealthPollInterval time.Duration
	HTTPClient         *http.Client
	DockerLogin        DockerLoginFunc // defaults to cache.DockerLogin if nil
	MountChecker       MountChecker    // defaults to RealMountChecker if nil
}

// NewEngine creates a new deployment engine.
func NewEngine(disk *DiskState, verifier *Verifier, cfg EngineConfig) *Engine {
	if cfg.ComposeCmd == "" {
		cfg.ComposeCmd = "docker compose"
	}
	if cfg.ComposeProjectName == "" {
		cfg.ComposeProjectName = "sam-env-" + SafeEnvironmentFilePart(cfg.EnvironmentID)
	}
	if cfg.CaddyfilePath == "" {
		cfg.CaddyfilePath = "/etc/caddy/Caddyfile"
	}
	if cfg.CaddyReloadCmd == "" {
		cfg.CaddyReloadCmd = "caddy reload --config {config} --adapter caddyfile"
	}
	if cfg.CaddyRestartCmd == "" {
		cfg.CaddyRestartCmd = "systemctl restart caddy"
	}
	if cfg.CaddyReadyTimeout == 0 {
		cfg.CaddyReadyTimeout = 2 * time.Minute
	}
	if cfg.CaddyReadyInterval == 0 {
		cfg.CaddyReadyInterval = 2 * time.Second
	}
	if cfg.HealthTimeout == 0 {
		cfg.HealthTimeout = 5 * time.Minute
	}
	if cfg.HealthPollInterval == 0 {
		cfg.HealthPollInterval = 5 * time.Second
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 30 * time.Second}
	}
	return &Engine{
		disk:          disk,
		verifier:      verifier,
		cfg:           cfg,
		callbackToken: cfg.CallbackToken,
	}
}

// SetCallbackToken updates the callback token for control plane requests.
// Safe to call concurrently with fetchRelease (heartbeat vs apply goroutine).
func (e *Engine) SetCallbackToken(token string) {
	e.tokenMu.Lock()
	defer e.tokenMu.Unlock()
	e.callbackToken = token
}

func (e *Engine) EnvironmentID() string {
	return e.cfg.EnvironmentID
}

// getCallbackToken returns the current callback token under a read lock.
func (e *Engine) getCallbackToken() string {
	e.tokenMu.RLock()
	defer e.tokenMu.RUnlock()
	return e.callbackToken
}

// SetVerifierKey updates the signing public key via the verifier's dual-key rotation.
func (e *Engine) SetVerifierKey(pubKeyB64 string) error {
	e.verifierMu.Lock()
	defer e.verifierMu.Unlock()

	if e.verifier == nil {
		verifier, err := NewVerifier(pubKeyB64)
		if err != nil {
			return err
		}
		e.verifier = verifier
		return nil
	}
	return e.verifier.SetCurrentKey(pubKeyB64)
}

// ReconcileOnStart reads disk state and verifies running containers match.
// It never recreates containers — it only updates the observed state.
func (e *Engine) ReconcileOnStart(ctx context.Context) error {
	state, err := e.disk.CurrentState()
	if err != nil {
		slog.Warn("deploy.reconcile: failed to read current state", "error", err)
		e.setObserved(ObservedState{})
		return nil // No state is a valid initial condition
	}
	if state == nil {
		slog.Info("deploy.reconcile: no previous release on disk")
		e.setObserved(ObservedState{})
		return nil
	}

	slog.Info("deploy.reconcile: found release on disk",
		"seq", state.Seq, "status", state.Status)

	// Check container state without modifying anything
	services, err := e.inspectServices(ctx, state.Seq)
	if err != nil {
		slog.Warn("deploy.reconcile: failed to inspect services",
			"seq", state.Seq, "error", err)
	}

	e.setObserved(ObservedState{
		AppliedSeq: state.Seq,
		Status:     state.Status,
		Services:   services,
	})

	return nil
}

// Apply executes an apply payload: verify, write to disk, pull, up, health check.
// Returns an error if the apply is rejected (signature, mutex, etc.) or fails.
func (e *Engine) Apply(ctx context.Context, payload *ApplyPayload) error {
	// Acquire apply mutex — TryLock rejects concurrent applies immediately
	if !e.applyMu.TryLock() {
		return fmt.Errorf("apply in progress")
	}
	defer e.applyMu.Unlock()

	// Get current applied seq for verification
	currentSeq, err := e.disk.CurrentSeq()
	if err != nil {
		return fmt.Errorf("read current seq: %w", err)
	}

	// Verify signature and binding constraints
	e.verifierMu.RLock()
	verifier := e.verifier
	e.verifierMu.RUnlock()
	if verifier == nil {
		return fmt.Errorf("no signature verifier configured — refusing to apply unsigned payload")
	}
	if err := verifier.Verify(payload, e.cfg.EnvironmentID, e.cfg.NodeID, currentSeq); err != nil {
		return fmt.Errorf("payload verification failed: %w", err)
	}

	slog.Info("deploy.apply: starting",
		"seq", payload.Seq, "prevSeq", currentSeq)

	// Mark as applying
	now := time.Now().UTC()
	newState := &ReleaseState{
		Seq:           payload.Seq,
		EnvironmentID: payload.EnvironmentID,
		NodeID:        payload.NodeID,
		Status:        StatusApplying,
		AppliedAt:     now,
	}

	e.setObserved(ObservedState{
		AppliedSeq: payload.Seq,
		Status:     StatusApplying,
	})

	// Write release to disk
	caddyfile, err := GenerateCaddySnippet(payload.Routes)
	if err != nil {
		return fmt.Errorf("generate Caddyfile: %w", err)
	}
	if err := e.disk.WriteRelease(newState, payload.ComposeYAML, caddyfile); err != nil {
		return fmt.Errorf("write release to disk: %w", err)
	}

	// Tear down the previous release's containers to free host ports.
	// Each release renders as a distinct compose project, so consecutive releases
	// compete for the same host port. We must down the old project before upping
	// the new one to avoid port-bind failures.
	if currentSeq > 0 {
		prevComposeFile := e.disk.ComposeFilePath(currentSeq)
		slog.Info("deploy.apply: tearing down previous release to free ports",
			"prevSeq", currentSeq)
		if err := e.composeDown(ctx, prevComposeFile); err != nil {
			slog.Warn("deploy.apply: failed to tear down previous release",
				"prevSeq", currentSeq, "error", err)
			// Continue anyway — the port may still be free if the previous
			// containers already exited or were removed externally.
		}
	}

	// Authenticate to private registry if credentials are provided
	if payload.RegistryCredentials != nil {
		slog.Info("deploy.apply: authenticating to container registry",
			"server", payload.RegistryCredentials.Server)
		loginFn := e.cfg.DockerLogin
		if loginFn == nil {
			loginFn = cache.DockerLogin
		}
		if err := loginFn(ctx,
			payload.RegistryCredentials.Server,
			payload.RegistryCredentials.Username,
			payload.RegistryCredentials.Password,
		); err != nil {
			return e.handleApplyFailure(ctx, newState, currentSeq, fmt.Errorf("docker login: %w", err))
		}
	}

	// Volume mount guard: refuse to apply if required SAM volumes are not mounted.
	// This prevents starting containers against a fell-through empty directory
	// when the provider volume has not been attached to this node.
	mountChecker := e.cfg.MountChecker
	if mountChecker == nil {
		mountChecker = RealMountChecker{}
	}
	if err := verifyVolumeMounts(payload.ComposeYAML, mountChecker); err != nil {
		return e.handleApplyFailure(ctx, newState, currentSeq, err)
	}

	// Execute docker compose
	composeFile := e.disk.ComposeFilePath(payload.Seq)
	if err := e.composePull(ctx, composeFile); err != nil {
		return e.handleApplyFailure(ctx, newState, currentSeq, fmt.Errorf("compose pull: %w", err))
	}

	if err := e.composeUp(ctx, composeFile); err != nil {
		return e.handleApplyFailure(ctx, newState, currentSeq, fmt.Errorf("compose up: %w", err))
	}

	// Wait for health checks
	if err := e.waitForHealth(ctx, payload.Seq); err != nil {
		return e.handleApplyFailure(ctx, newState, currentSeq, fmt.Errorf("health check: %w", err))
	}

	if err := e.reloadCaddy(ctx, e.disk.CaddyfilePath(payload.Seq)); err != nil {
		return e.handleApplyFailure(ctx, newState, currentSeq, fmt.Errorf("caddy reload: %w", err))
	}

	newState.Status = StatusApplied
	if err := e.disk.UpdateState(newState); err != nil {
		return e.handleApplyFailure(ctx, newState, currentSeq, fmt.Errorf("update applied metadata: %w", err))
	}

	// Success: update current pointer only after metadata is durably applied.
	if err := e.disk.SetCurrent(payload.Seq); err != nil {
		return e.handleApplyFailure(ctx, newState, currentSeq, fmt.Errorf("set current pointer: %w", err))
	}

	services, _ := e.inspectServices(ctx, payload.Seq)
	e.setObserved(ObservedState{
		AppliedSeq: payload.Seq,
		Status:     StatusApplied,
		Services:   services,
	})

	slog.Info("deploy.apply: success", "seq", payload.Seq)
	return nil
}

// handleApplyFailure reverts to the previous release or marks as failed-initial.
func (e *Engine) handleApplyFailure(ctx context.Context, state *ReleaseState, previousSeq int64, applyErr error) error {
	slog.Error("deploy.apply: failed, reverting",
		"seq", state.Seq, "prevSeq", previousSeq, "error", applyErr)

	state.FailedAt = time.Now().UTC()
	state.ErrorMessage = applyErr.Error()

	if previousSeq == 0 {
		// First release with nothing to revert to
		state.Status = StatusFailedInitial

		// Stop any containers that may have started
		composeFile := e.disk.ComposeFilePath(state.Seq)
		if err := e.composeDown(ctx, composeFile); err != nil {
			slog.Warn("deploy.apply: failed to stop containers after failed-initial",
				"error", err)
		}

		_ = e.disk.UpdateState(state)
		e.setObserved(ObservedState{
			AppliedSeq:   0,
			Status:       StatusFailedInitial,
			ErrorMessage: applyErr.Error(),
		})
		return fmt.Errorf("apply failed (no previous release to revert): %w", applyErr)
	}

	// Revert to previous release
	state.Status = StatusFailed
	_ = e.disk.UpdateState(state)

	// Tear down the partially-started new release before bringing the previous
	// one back up. Otherwise its containers may still hold the host port and the
	// revert composeUp fails with "port already in use" — the exact rebind
	// conflict T1 prevents on the happy path. Best-effort: log and continue.
	newComposeFile := e.disk.ComposeFilePath(state.Seq)
	if err := e.composeDown(ctx, newComposeFile); err != nil {
		slog.Warn("deploy.apply: failed to stop new release before revert",
			"seq", state.Seq, "error", err)
	}

	prevComposeFile := e.disk.ComposeFilePath(previousSeq)
	if err := e.composeUp(ctx, prevComposeFile); err != nil {
		slog.Error("deploy.apply: revert also failed",
			"prevSeq", previousSeq, "error", err)
		e.setObserved(ObservedState{
			AppliedSeq:   previousSeq,
			Status:       StatusFailed,
			ErrorMessage: applyErr.Error(),
		})
		return fmt.Errorf("apply failed and revert failed: apply=%w, revert=%v", applyErr, err)
	}

	if err := e.reloadCaddy(ctx, e.disk.CaddyfilePath(previousSeq)); err != nil {
		slog.Error("deploy.apply: caddy reload for reverted release failed",
			"prevSeq", previousSeq, "error", err)
	}

	// Restore current pointer to previous
	_ = e.disk.SetCurrent(previousSeq)

	// Update previous release state to show it was reverted-to
	prevState, err := e.disk.ReadState(previousSeq)
	if err == nil {
		prevState.Status = StatusApplied
		_ = e.disk.UpdateState(prevState)
	}

	services, _ := e.inspectServices(ctx, previousSeq)
	e.setObserved(ObservedState{
		AppliedSeq: previousSeq,
		Status:     StatusReverted,
		Services:   services,
	})

	slog.Info("deploy.apply: reverted to previous release",
		"failedSeq", state.Seq, "revertedTo", previousSeq)
	return fmt.Errorf("apply failed, reverted to seq %d: %w", previousSeq, applyErr)
}

// GetObserved returns the current observed deployment state (thread-safe).
func (e *Engine) GetObserved() ObservedState {
	e.observedMu.RLock()
	defer e.observedMu.RUnlock()
	return e.observed
}

func (e *Engine) setObserved(state ObservedState) {
	e.observedMu.Lock()
	e.observed = state
	e.observedMu.Unlock()
}

// FetchAndApply fetches the apply payload from the control plane and applies it.
func (e *Engine) FetchAndApply(ctx context.Context, pendingSeq int64) error {
	payload, err := e.fetchRelease(ctx, pendingSeq)
	if err != nil {
		return fmt.Errorf("fetch release seq=%d: %w", pendingSeq, err)
	}
	return e.Apply(ctx, payload)
}

func (e *Engine) fetchRelease(ctx context.Context, seq int64) (*ApplyPayload, error) {
	url := fmt.Sprintf("%s/api/nodes/%s/deploy-release?seq=%d&environmentId=%s",
		strings.TrimRight(e.cfg.ControlPlaneURL, "/"),
		e.cfg.NodeID,
		seq,
		e.cfg.EnvironmentID,
	)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+e.getCallbackToken())

	resp, err := e.cfg.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("unexpected status %d: %s", resp.StatusCode, string(body))
	}

	var payload ApplyPayload
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode payload: %w", err)
	}
	return &payload, nil
}

// Docker Compose helpers

func (e *Engine) composePull(ctx context.Context, composeFile string) error {
	return e.runCompose(ctx, composeFile, "pull")
}

func (e *Engine) composeUp(ctx context.Context, composeFile string) error {
	return e.runCompose(ctx, composeFile, "up", "-d", "--remove-orphans")
}

func (e *Engine) composeDown(ctx context.Context, composeFile string) error {
	return e.runCompose(ctx, composeFile, "down")
}

func (e *Engine) runCompose(ctx context.Context, composeFile string, args ...string) error {
	parts := strings.Fields(e.cfg.ComposeCmd)
	cmdArgs := append(parts[1:], "--project-name", e.cfg.ComposeProjectName, "-f", composeFile)
	cmdArgs = append(cmdArgs, args...)

	cmd := exec.CommandContext(ctx, parts[0], cmdArgs...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s %s: %w (stderr: %s)",
			e.cfg.ComposeCmd, strings.Join(args, " "), err, stderr.String())
	}
	return nil
}

func (e *Engine) reloadCaddy(ctx context.Context, releaseCaddyfile string) error {
	content, err := os.ReadFile(releaseCaddyfile)
	if err != nil {
		return fmt.Errorf("read release Caddy snippet: %w", err)
	}
	sitesDir := filepath.Join(filepath.Dir(e.cfg.CaddyfilePath), "sites")
	if err := os.MkdirAll(sitesDir, 0755); err != nil {
		return fmt.Errorf("create caddy sites dir: %w", err)
	}
	root := GenerateRootCaddyfile(CaddyfileOptions{
		ACMEEmail: e.cfg.ACMEEmail,
		ACMECA:    e.cfg.ACMECA,
	})
	if err := writeFileAtomic(e.cfg.CaddyfilePath, root, 0644); err != nil {
		return fmt.Errorf("write root Caddyfile: %w", err)
	}
	snippetPath := filepath.Join(sitesDir, SafeEnvironmentFilePart(e.cfg.EnvironmentID)+".caddy")
	if err := writeFileAtomic(snippetPath, string(content), 0644); err != nil {
		return fmt.Errorf("write active Caddy snippet: %w", err)
	}

	parts := strings.Fields(e.cfg.CaddyReloadCmd)
	if len(parts) == 0 {
		return fmt.Errorf("empty caddy reload command")
	}
	for i, part := range parts {
		parts[i] = strings.ReplaceAll(part, "{config}", e.cfg.CaddyfilePath)
	}
	if err := e.waitForReloadCommand(ctx, parts[0]); err != nil {
		return err
	}

	cmd := exec.CommandContext(ctx, parts[0], parts[1:]...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if isCaddyAdminUnavailable(stderr.String()) {
			if restartErr := e.restartCaddy(ctx); restartErr != nil {
				return fmt.Errorf("%s: %w (stderr: %s; restart failed: %v)", e.cfg.CaddyReloadCmd, err, stderr.String(), restartErr)
			}
			return nil
		}
		return fmt.Errorf("%s: %w (stderr: %s)", e.cfg.CaddyReloadCmd, err, stderr.String())
	}
	return nil
}

func (e *Engine) restartCaddy(ctx context.Context) error {
	parts := strings.Fields(e.cfg.CaddyRestartCmd)
	if len(parts) == 0 {
		return fmt.Errorf("empty caddy restart command")
	}
	cmd := exec.CommandContext(ctx, parts[0], parts[1:]...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: %w (stderr: %s)", e.cfg.CaddyRestartCmd, err, stderr.String())
	}
	return nil
}

func isCaddyAdminUnavailable(stderr string) bool {
	return strings.Contains(stderr, "localhost:2019/load") && strings.Contains(stderr, "connection refused")
}

func (e *Engine) waitForReloadCommand(ctx context.Context, command string) error {
	if _, err := exec.LookPath(command); err == nil {
		return nil
	}

	deadline := time.NewTimer(e.cfg.CaddyReadyTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(e.cfg.CaddyReadyInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("caddy reload command %q not available before context deadline: %w", command, ctx.Err())
		case <-deadline.C:
			return fmt.Errorf("caddy reload command %q not available after %s", command, e.cfg.CaddyReadyTimeout)
		case <-ticker.C:
			if _, err := exec.LookPath(command); err == nil {
				return nil
			}
		}
	}
}

func (e *Engine) waitForHealth(ctx context.Context, seq int64) error {
	deadline := time.NewTimer(e.cfg.HealthTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(e.cfg.HealthPollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("health check timed out after %s", e.cfg.HealthTimeout)
		case <-ticker.C:
			services, err := e.inspectServices(ctx, seq)
			if err != nil {
				slog.Debug("deploy.health: inspect failed", "error", err)
				continue
			}

			allHealthy := true
			for _, svc := range services {
				if svc.Status != "running" {
					allHealthy = false
					break
				}
				// If health check is configured, it must be healthy
				if svc.Health != "" && svc.Health != "healthy" && svc.Health != "none" {
					allHealthy = false
					break
				}
			}

			if allHealthy && len(services) > 0 {
				return nil
			}
		}
	}
}

func (e *Engine) inspectServices(ctx context.Context, seq int64) ([]ServiceState, error) {
	composeFile := e.disk.ComposeFilePath(seq)

	parts := strings.Fields(e.cfg.ComposeCmd)
	cmdArgs := append(parts[1:], "--project-name", e.cfg.ComposeProjectName, "-f", composeFile, "ps", "--format", "json")

	cmd := exec.CommandContext(ctx, parts[0], cmdArgs...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("compose ps: %w (stderr: %s)", err, stderr.String())
	}

	// docker compose ps --format json outputs one JSON object per line
	var services []ServiceState
	for _, line := range strings.Split(strings.TrimSpace(stdout.String()), "\n") {
		if line == "" {
			continue
		}
		var container struct {
			Name   string `json:"Name"`
			State  string `json:"State"`
			Health string `json:"Health"`
		}
		if err := json.Unmarshal([]byte(line), &container); err != nil {
			slog.Debug("deploy.inspect: failed to parse container JSON", "line", line, "error", err)
			continue
		}
		services = append(services, ServiceState{
			Name:   container.Name,
			Status: container.State,
			Health: container.Health,
		})
	}
	return services, nil
}
