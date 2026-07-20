package deploy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/workspace/vm-agent/internal/cache"
	"github.com/workspace/vm-agent/internal/config"
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

type ApplyProgressFunc func(ctx context.Context, event ApplyProgressEvent)

type ApplyProgressEvent struct {
	EnvironmentID string
	NodeID        string
	Seq           int64
	Level         string
	EventType     string
	Step          string
	Message       string
	Detail        map[string]any
}

// EngineConfig holds the configuration for the deploy engine.
type EngineConfig struct {
	EnvironmentID       string
	NodeID              string
	ControlPlaneURL     string
	CallbackToken       string
	ComposeCmd          string // e.g., "docker compose"
	ComposeProjectName  string
	CaddyfilePath       string
	CaddyReloadCmd      string
	CaddyRestartCmd     string
	ACMEEmail           string // Contact email for the ACME global options block (optional)
	ACMECA              string // ACME CA directory URL override, e.g. LE staging (optional)
	CaddyReadyTimeout   time.Duration
	CaddyReadyInterval  time.Duration
	HealthTimeout       time.Duration
	HealthPollInterval  time.Duration
	HTTPClient          *http.Client
	ArtifactIdleTimeout time.Duration
	ApplyProgress       ApplyProgressFunc
	DockerLogin         DockerLoginFunc // defaults to cache.DockerLogin if nil
	MountChecker        MountChecker    // defaults to RealMountChecker if nil
	VolumeMounter       VolumeMounter   // defaults to RealVolumeMounter if nil
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
		cfg.HTTPClient = NewArtifactHTTPClient(ArtifactHTTPClientConfig{})
	}
	if cfg.ArtifactIdleTimeout == 0 {
		cfg.ArtifactIdleTimeout = config.DefaultDeployArtifactIdleTimeout
	}
	return &Engine{
		disk:          disk,
		verifier:      verifier,
		cfg:           cfg,
		callbackToken: cfg.CallbackToken,
	}
}

// Teardown stops the current compose project and removes only this
// environment's active Caddy snippet from the node-level import directory.
func (e *Engine) Teardown(ctx context.Context) error {
	e.applyMu.Lock()
	defer e.applyMu.Unlock()

	var errs []string
	var mountRoots []string
	interpolationEnv, envErr := e.fetchCurrentInterpolationEnv(ctx)
	if envErr != nil {
		slog.Warn("deploy.teardown: failed to fetch current interpolation env; falling back to label cleanup if compose down fails", "error", envErr)
	}
	if currentSeq, err := e.disk.CurrentSeq(); err == nil && currentSeq > 0 {
		var rootsErr error
		mountRoots, rootsErr = e.releaseVolumeMountRoots(currentSeq)
		if rootsErr != nil {
			errs = append(errs, fmt.Sprintf("read volume mount roots: %v", rootsErr))
		}
		composeFile := e.disk.ComposeFilePath(currentSeq)
		if err := e.composeDown(ctx, composeFile, interpolationEnv); err != nil {
			errs = append(errs, fmt.Sprintf("compose down: %v", err))
			if envErr != nil {
				if fallbackErr := e.cleanupComposeProjectByLabel(ctx); fallbackErr != nil {
					errs = append(errs, fmt.Sprintf("compose label cleanup: %v", fallbackErr))
				}
			}
		}
	} else if err != nil {
		errs = append(errs, fmt.Sprintf("read current release: %v", err))
	}

	if err := e.teardownVolumeMountRoots(ctx, mountRoots); err != nil {
		errs = append(errs, fmt.Sprintf("teardown volume mounts: %v", err))
	}

	snippetPath := filepath.Join(filepath.Dir(e.cfg.CaddyfilePath), "sites", SafeEnvironmentFilePart(e.cfg.EnvironmentID)+".caddy")
	if err := os.Remove(snippetPath); err != nil && !os.IsNotExist(err) {
		errs = append(errs, fmt.Sprintf("remove Caddy snippet: %v", err))
	}

	root := GenerateRootCaddyfile(CaddyfileOptions{
		ACMEEmail: e.cfg.ACMEEmail,
		ACMECA:    e.cfg.ACMECA,
	})
	if err := writeFileAtomic(e.cfg.CaddyfilePath, root, 0644); err != nil {
		errs = append(errs, fmt.Sprintf("write root Caddyfile: %v", err))
	} else if err := e.reloadActiveCaddyConfig(ctx); err != nil {
		errs = append(errs, fmt.Sprintf("reload Caddy: %v", err))
	}

	if len(errs) > 0 {
		return fmt.Errorf("teardown environment %s: %s", e.cfg.EnvironmentID, strings.Join(errs, "; "))
	}
	if err := e.disk.ClearCurrent(); err != nil {
		return fmt.Errorf("teardown environment %s: %w", e.cfg.EnvironmentID, err)
	}
	e.setObserved(ObservedState{})
	return nil
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
	interpolationEnv, envErr := e.fetchCurrentInterpolationEnv(ctx)
	if envErr != nil {
		slog.Warn("deploy.reconcile: failed to fetch current interpolation env; skipping service details",
			"seq", state.Seq, "error", envErr)
		e.setObserved(ObservedState{
			AppliedSeq:      state.Seq,
			Status:          state.Status,
			RoutingRevision: state.RoutingRevision,
			RoutingStatus:   state.RoutingStatus,
			RoutingError:    state.RoutingError,
		})
		return nil
	}

	services, err := e.inspectServices(ctx, state.Seq, interpolationEnv)
	if err != nil {
		slog.Warn("deploy.reconcile: failed to inspect services",
			"seq", state.Seq, "error", err)
	}

	e.setObserved(ObservedState{
		AppliedSeq:      state.Seq,
		Status:          state.Status,
		RoutingRevision: state.RoutingRevision,
		RoutingStatus:   state.RoutingStatus,
		RoutingError:    state.RoutingError,
		Services:        services,
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
	if err := validateVolumeMountsForEnvironment(e.cfg.EnvironmentID, payload.VolumeMounts); err != nil {
		return fmt.Errorf("volume mount validation failed: %w", err)
	}
	e.reportApplyEvent(ctx, payload, "info", "deployment.apply.payload_verified", "verify_payload", "deployment payload verified", map[string]any{"previousSeq": currentSeq})

	slog.Info("deploy.apply: starting",
		"seq", payload.Seq, "prevSeq", currentSeq)
	e.reportApplyEvent(ctx, payload, "info", "deployment.apply.started", "apply", "deployment apply started", map[string]any{"previousSeq": currentSeq, "artifactCount": len(payload.Artifacts)})
	applyEnv := payload.InterpolationEnv
	redactor := newEnvRedactor(applyEnv)

	// Mark as applying
	now := time.Now().UTC()
	newState := &ReleaseState{
		Seq:              payload.Seq,
		EnvironmentID:    payload.EnvironmentID,
		NodeID:           payload.NodeID,
		Status:           StatusApplying,
		AppliedAt:        now,
		VolumeMountRoots: volumeMountRootsFromPayload(payload.VolumeMounts),
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
	e.reportApplyEvent(ctx, payload, "info", "deployment.apply.release_written", "write_release", "release files written to disk", nil)

	// Tear down the previous release's containers to free host ports.
	// Each release renders as a distinct compose project, so consecutive releases
	// compete for the same host port. We must down the old project before upping
	// the new one to avoid port-bind failures.
	var removedRoots []string
	if currentSeq > 0 {
		prevComposeFile := e.disk.ComposeFilePath(currentSeq)
		slog.Info("deploy.apply: tearing down previous release to free ports",
			"prevSeq", currentSeq)
		e.reportApplyEvent(ctx, payload, "info", "deployment.apply.previous_down_started", "previous_down", "stopping previous release containers", map[string]any{"previousSeq": currentSeq})
		if err := e.composeDown(ctx, prevComposeFile, applyEnv); err != nil {
			slog.Warn("deploy.apply: failed to tear down previous release",
				"prevSeq", currentSeq, "error", err)
			e.reportApplyEvent(ctx, payload, "warn", "deployment.apply.previous_down_failed", "previous_down", "failed to stop previous release containers", map[string]any{"previousSeq": currentSeq, "error": err.Error()})
			// Continue anyway — the port may still be free if the previous
			// containers already exited or were removed externally.
		} else {
			e.reportApplyEvent(ctx, payload, "info", "deployment.apply.previous_down_completed", "previous_down", "previous release containers stopped", map[string]any{"previousSeq": currentSeq})
		}
		var err error
		removedRoots, err = e.removedVolumeMountRoots(currentSeq, newState.VolumeMountRoots)
		if err != nil {
			return e.handleApplyFailure(ctx, newState, currentSeq, redactor.redactError(fmt.Errorf("read removed volume mounts: %w", err)), applyEnv)
		}
	}

	// Authenticate to private registry if credentials are provided
	if payload.RegistryCredentials != nil {
		slog.Info("deploy.apply: authenticating to container registry",
			"server", payload.RegistryCredentials.Server)
		e.reportApplyEvent(ctx, payload, "info", "deployment.apply.registry_login_started", "registry_login", "authenticating to container registry", map[string]any{"server": payload.RegistryCredentials.Server})
		loginFn := e.cfg.DockerLogin
		if loginFn == nil {
			loginFn = cache.DockerLogin
		}
		if err := loginFn(ctx,
			payload.RegistryCredentials.Server,
			payload.RegistryCredentials.Username,
			payload.RegistryCredentials.Password,
		); err != nil {
			return e.handleApplyFailure(ctx, newState, currentSeq, redactor.redactError(fmt.Errorf("docker login: %w", err)), applyEnv)
		}
		e.reportApplyEvent(ctx, payload, "info", "deployment.apply.registry_login_completed", "registry_login", "container registry authentication completed", map[string]any{"server": payload.RegistryCredentials.Server})
	}

	if len(payload.VolumeMounts) > 0 {
		volumeMounter := e.cfg.VolumeMounter
		if volumeMounter == nil {
			volumeMounter = NewRealVolumeMounter()
		}
		e.reportApplyEvent(ctx, payload, "info", "deployment.apply.volume_mount_started", "volume_mounts", "mounting deployment volumes", map[string]any{"volumeMountCount": len(payload.VolumeMounts)})
		if err := volumeMounter.MountVolumes(ctx, payload.VolumeMounts); err != nil {
			return e.handleApplyFailure(ctx, newState, currentSeq, redactor.redactError(fmt.Errorf("mount volumes: %w", err)), applyEnv)
		}
		e.reportApplyEvent(ctx, payload, "info", "deployment.apply.volume_mount_completed", "volume_mounts", "deployment volumes mounted", map[string]any{"volumeMountCount": len(payload.VolumeMounts)})
	}

	// Volume mount guard: refuse to apply if required SAM volumes are not mounted.
	// This prevents starting containers against a fell-through empty directory
	// when the provider volume has not been attached to this node.
	mountChecker := e.cfg.MountChecker
	if mountChecker == nil {
		mountChecker = RealMountChecker{}
	}
	if err := verifyVolumeMounts(payload.ComposeYAML, mountChecker); err != nil {
		return e.handleApplyFailure(ctx, newState, currentSeq, redactor.redactError(err), applyEnv)
	}
	e.reportApplyEvent(ctx, payload, "info", "deployment.apply.volume_mounts_verified", "volume_mounts", "volume mounts verified", nil)

	// Execute docker compose
	composeFile := e.disk.ComposeFilePath(payload.Seq)
	e.reportApplyEvent(ctx, payload, "info", "deployment.apply.artifacts_load_started", "load_artifacts", "loading image artifacts", map[string]any{"artifactCount": len(payload.Artifacts)})
	if err := e.loadImageArtifacts(ctx, payload.Artifacts); err != nil {
		return e.handleApplyFailure(ctx, newState, currentSeq, redactor.redactError(fmt.Errorf("load image artifacts: %w", err)), applyEnv)
	}
	e.reportApplyEvent(ctx, payload, "info", "deployment.apply.artifacts_load_completed", "load_artifacts", "image artifacts loaded", map[string]any{"artifactCount": len(payload.Artifacts)})
	e.reportApplyEvent(ctx, payload, "info", "deployment.apply.compose_config_started", "compose_config", "running compose config preflight", nil)
	if err := e.composeConfigPreflight(ctx, composeFile, applyEnv); err != nil {
		return e.handleApplyFailure(ctx, newState, currentSeq, redactor.redactError(fmt.Errorf("compose config: %w", err)), applyEnv)
	}
	e.reportApplyEvent(ctx, payload, "info", "deployment.apply.compose_config_completed", "compose_config", "compose config preflight completed", nil)

	if len(payload.Artifacts) == 0 {
		e.reportApplyEvent(ctx, payload, "info", "deployment.apply.compose_pull_started", "compose_pull", "pulling compose images", nil)
		if err := e.composePull(ctx, composeFile, applyEnv); err != nil {
			return e.handleApplyFailure(ctx, newState, currentSeq, redactor.redactError(fmt.Errorf("compose pull: %w", err)), applyEnv)
		}
		e.reportApplyEvent(ctx, payload, "info", "deployment.apply.compose_pull_completed", "compose_pull", "compose images pulled", nil)
	} else {
		slog.Info("deploy.apply: skipping compose pull for artifact-backed release",
			"seq", payload.Seq, "artifactCount", len(payload.Artifacts))
		e.reportApplyEvent(ctx, payload, "info", "deployment.apply.compose_pull_skipped", "compose_pull", "skipped compose pull for artifact-backed release", map[string]any{"artifactCount": len(payload.Artifacts)})
	}

	e.reportApplyEvent(ctx, payload, "info", "deployment.apply.compose_up_started", "compose_up", "starting compose services", nil)
	if err := e.composeUp(ctx, composeFile, applyEnv); err != nil {
		return e.handleApplyFailure(ctx, newState, currentSeq, redactor.redactError(fmt.Errorf("compose up: %w", err)), applyEnv)
	}
	e.reportApplyEvent(ctx, payload, "info", "deployment.apply.compose_up_completed", "compose_up", "compose services started", nil)

	// Wait for health checks
	e.reportApplyEvent(ctx, payload, "info", "deployment.apply.health_check_started", "health_check", "waiting for deployment health checks", nil)
	if err := e.waitForHealth(ctx, payload.Seq, payload.Routes, applyEnv); err != nil {
		// waitForHealth already redacts docker compose diagnostics while keeping
		// typed timeout details available for observed-state reporting.
		return e.handleApplyFailure(ctx, newState, currentSeq, fmt.Errorf("health check: %w", err), applyEnv)
	}
	e.reportApplyEvent(ctx, payload, "info", "deployment.apply.health_check_completed", "health_check", "deployment health checks passed", nil)

	e.reportApplyEvent(ctx, payload, "info", "deployment.apply.caddy_reload_started", "caddy_reload", "reloading Caddy configuration", nil)
	if err := e.reloadCaddy(ctx, e.disk.CaddyfilePath(payload.Seq)); err != nil {
		return e.handleApplyFailure(ctx, newState, currentSeq, redactor.redactError(fmt.Errorf("caddy reload: %w", err)), applyEnv)
	}
	e.reportApplyEvent(ctx, payload, "info", "deployment.apply.caddy_reload_completed", "caddy_reload", "Caddy configuration reloaded", nil)

	newState.Status = StatusApplied
	if err := e.disk.UpdateState(newState); err != nil {
		return e.handleApplyFailure(ctx, newState, currentSeq, redactor.redactError(fmt.Errorf("update applied metadata: %w", err)), applyEnv)
	}
	e.reportApplyEvent(ctx, payload, "info", "deployment.apply.state_persisted", "persist_state", "applied state persisted", nil)

	// Success: update current pointer only after metadata is durably applied.
	if err := e.disk.SetCurrent(payload.Seq); err != nil {
		return e.handleApplyFailure(ctx, newState, currentSeq, redactor.redactError(fmt.Errorf("set current pointer: %w", err)), applyEnv)
	}

	if len(removedRoots) > 0 {
		if err := e.teardownVolumeMountRoots(ctx, removedRoots); err != nil {
			slog.Warn("deploy.apply: failed to teardown removed volume mounts after successful update",
				"seq", payload.Seq, "error", err)
			e.reportApplyEvent(ctx, payload, "warn", "deployment.apply.removed_volume_teardown_failed", "volume_mounts", "failed to teardown removed volume mounts after successful update", map[string]any{"error": err.Error()})
		}
	}

	services, _ := e.inspectServices(ctx, payload.Seq, applyEnv)
	e.setObserved(ObservedState{
		AppliedSeq: payload.Seq,
		Status:     StatusApplied,
		Services:   services,
	})

	slog.Info("deploy.apply: success", "seq", payload.Seq)
	e.reportApplyEvent(ctx, payload, "info", "deployment.apply.succeeded", "succeeded", "deployment apply succeeded", nil)
	return nil
}

// handleApplyFailure reverts to the previous release or marks as failed-initial.
func (e *Engine) handleApplyFailure(ctx context.Context, state *ReleaseState, previousSeq int64, applyErr error, applyEnv map[string]string) error {
	slog.Error("deploy.apply: failed, reverting",
		"seq", state.Seq, "prevSeq", previousSeq, "error", applyErr)
	e.reportApplyEvent(ctx, &ApplyPayload{EnvironmentID: state.EnvironmentID, NodeID: state.NodeID, Seq: state.Seq}, "error", "deployment.apply.failed", "failed", "deployment apply failed", map[string]any{"previousSeq": previousSeq, "error": applyErr.Error()})

	state.FailedAt = time.Now().UTC()
	state.ErrorMessage = applyErr.Error()

	if previousSeq == 0 {
		// First release with nothing to revert to
		state.Status = StatusFailedInitial

		// Stop any containers that may have started
		composeFile := e.disk.ComposeFilePath(state.Seq)
		e.reportApplyEvent(ctx, &ApplyPayload{EnvironmentID: state.EnvironmentID, NodeID: state.NodeID, Seq: state.Seq}, "info", "deployment.apply.cleanup_started", "cleanup_failed_initial", "stopping containers after failed initial apply", nil)
		if err := e.composeDown(ctx, composeFile, applyEnv); err != nil {
			slog.Warn("deploy.apply: failed to stop containers after failed-initial",
				"error", err)
		}
		if err := e.clearActiveCaddySnippet(ctx); err != nil {
			slog.Warn("deploy.apply: failed to clear Caddy snippet after failed-initial",
				"error", err)
		}

		var persistenceErrs []error
		if err := e.teardownVolumeMountRoots(ctx, state.VolumeMountRoots); err != nil {
			slog.Warn("deploy.apply: failed to teardown volume mounts after failed-initial",
				"error", err)
			persistenceErrs = append(persistenceErrs, fmt.Errorf("teardown failed-initial volume mounts: %w", err))
		}
		if err := e.disk.UpdateState(state); err != nil {
			slog.Error("deploy.apply: failed to persist failed-initial state",
				"seq", state.Seq, "error", err)
			persistenceErrs = append(persistenceErrs, fmt.Errorf("persist failed-initial state: %w", err))
		}
		var healthErr *healthTimeoutError
		var failedServices []ServiceState
		if errors.As(applyErr, &healthErr) {
			failedServices = healthErr.Services()
		}
		e.setObserved(ObservedState{
			AppliedSeq:   0,
			Status:       StatusFailedInitial,
			ErrorMessage: applyErr.Error(),
			Services:     failedServices,
		})
		e.reportApplyEvent(ctx, &ApplyPayload{EnvironmentID: state.EnvironmentID, NodeID: state.NodeID, Seq: state.Seq}, "error", "deployment.apply.failed_initial", "failed_initial", "deployment apply failed with no previous release to revert to", map[string]any{"error": applyErr.Error()})
		return errors.Join(
			fmt.Errorf("apply failed (no previous release to revert): %w", applyErr),
			errors.Join(persistenceErrs...),
		)
	}

	// Revert to previous release
	var recoveryErrs []error
	state.Status = StatusFailed
	e.reportApplyEvent(ctx, &ApplyPayload{EnvironmentID: state.EnvironmentID, NodeID: state.NodeID, Seq: state.Seq}, "info", "deployment.apply.revert_started", "revert", "reverting to previous release", map[string]any{"previousSeq": previousSeq})
	if err := e.disk.UpdateState(state); err != nil {
		slog.Error("deploy.apply: failed to persist failed release state",
			"seq", state.Seq, "error", err)
		recoveryErrs = append(recoveryErrs, fmt.Errorf("persist failed release state: %w", err))
	}

	// Tear down the partially-started new release before bringing the previous
	// one back up. Otherwise its containers may still hold the host port and the
	// revert composeUp fails with "port already in use" — the exact rebind
	// conflict T1 prevents on the happy path. Best-effort: log and continue.
	newComposeFile := e.disk.ComposeFilePath(state.Seq)
	if err := e.composeDown(ctx, newComposeFile, applyEnv); err != nil {
		slog.Warn("deploy.apply: failed to stop new release before revert",
			"seq", state.Seq, "error", err)
	}
	previousRoots, rootsErr := e.releaseVolumeMountRoots(previousSeq)
	if rootsErr != nil {
		recoveryErrs = append(recoveryErrs, fmt.Errorf("read previous volume mount roots: %w", rootsErr))
	}
	if err := e.teardownVolumeMountRoots(ctx, subtractVolumeMountRoots(state.VolumeMountRoots, previousRoots)); err != nil {
		slog.Warn("deploy.apply: failed to teardown new release volume mounts before revert",
			"seq", state.Seq, "error", err)
		recoveryErrs = append(recoveryErrs, fmt.Errorf("teardown failed release volume mounts: %w", err))
	}

	prevComposeFile := e.disk.ComposeFilePath(previousSeq)
	if err := e.composeUp(ctx, prevComposeFile, applyEnv); err != nil {
		slog.Error("deploy.apply: revert also failed",
			"prevSeq", previousSeq, "error", err)
		e.setObserved(ObservedState{
			AppliedSeq:   previousSeq,
			Status:       StatusFailed,
			ErrorMessage: applyErr.Error(),
		})
		return errors.Join(
			fmt.Errorf("apply failed and revert failed: apply=%w, revert=%v", applyErr, err),
			errors.Join(recoveryErrs...),
		)
	}

	if err := e.reloadCaddy(ctx, e.disk.CaddyfilePath(previousSeq)); err != nil {
		slog.Error("deploy.apply: caddy reload for reverted release failed",
			"prevSeq", previousSeq, "error", err)
		recoveryErrs = append(recoveryErrs, fmt.Errorf("reload reverted caddy: %w", err))
	}

	// Restore current pointer to previous
	if err := e.disk.SetCurrent(previousSeq); err != nil {
		slog.Error("deploy.apply: failed to restore current pointer after revert",
			"prevSeq", previousSeq, "error", err)
		recoveryErrs = append(recoveryErrs, fmt.Errorf("restore current pointer after revert: %w", err))
	}

	// Update previous release state to show it was reverted-to
	prevState, err := e.disk.ReadState(previousSeq)
	if err == nil {
		prevState.Status = StatusApplied
		if err := e.disk.UpdateState(prevState); err != nil {
			slog.Error("deploy.apply: failed to persist reverted release state",
				"prevSeq", previousSeq, "error", err)
			recoveryErrs = append(recoveryErrs, fmt.Errorf("persist reverted release state: %w", err))
		}
	} else {
		slog.Error("deploy.apply: failed to read previous release state after revert",
			"prevSeq", previousSeq, "error", err)
		recoveryErrs = append(recoveryErrs, fmt.Errorf("read previous release state after revert: %w", err))
	}

	services, _ := e.inspectServices(ctx, previousSeq, applyEnv)
	e.setObserved(ObservedState{
		AppliedSeq:   previousSeq,
		Status:       StatusReverted,
		ErrorMessage: applyErr.Error(),
		Services:     services,
	})

	slog.Info("deploy.apply: reverted to previous release",
		"failedSeq", state.Seq, "revertedTo", previousSeq)
	e.reportApplyEvent(ctx, &ApplyPayload{EnvironmentID: state.EnvironmentID, NodeID: state.NodeID, Seq: state.Seq}, "warn", "deployment.apply.reverted", "revert", "deployment reverted to previous release", map[string]any{"previousSeq": previousSeq, "error": applyErr.Error()})
	return errors.Join(
		fmt.Errorf("apply failed, reverted to seq %d: %w", previousSeq, applyErr),
		errors.Join(recoveryErrs...),
	)
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
	e.reportApplyEvent(ctx, &ApplyPayload{EnvironmentID: e.cfg.EnvironmentID, NodeID: e.cfg.NodeID, Seq: pendingSeq}, "info", "deployment.apply.fetch_started", "fetch_release", "fetching pending deployment release", nil)
	payload, err := e.fetchRelease(ctx, pendingSeq)
	if err != nil {
		return fmt.Errorf("fetch release seq=%d: %w", pendingSeq, err)
	}
	e.reportApplyEvent(ctx, payload, "info", "deployment.apply.fetch_completed", "fetch_release", "pending deployment release fetched", map[string]any{"artifactCount": len(payload.Artifacts)})
	return e.Apply(ctx, payload)
}

func (e *Engine) fetchRelease(ctx context.Context, seq int64) (*ApplyPayload, error) {
	requestURL, err := url.Parse(fmt.Sprintf("%s/api/nodes/%s/deploy-release",
		strings.TrimRight(e.cfg.ControlPlaneURL, "/"),
		url.PathEscape(e.cfg.NodeID),
	))
	if err != nil {
		return nil, fmt.Errorf("build release URL: %w", err)
	}
	query := requestURL.Query()
	query.Set("seq", fmt.Sprintf("%d", seq))
	query.Set("environmentId", e.cfg.EnvironmentID)
	requestURL.RawQuery = query.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
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

func (e *Engine) fetchCurrentInterpolationEnv(ctx context.Context) (map[string]string, error) {
	if strings.TrimSpace(e.cfg.ControlPlaneURL) == "" || strings.TrimSpace(e.getCallbackToken()) == "" {
		return nil, nil
	}
	requestURL, err := url.Parse(fmt.Sprintf("%s/api/nodes/%s/deployment-env",
		strings.TrimRight(e.cfg.ControlPlaneURL, "/"),
		url.PathEscape(e.cfg.NodeID),
	))
	if err != nil {
		return nil, fmt.Errorf("build deployment env URL: %w", err)
	}
	query := requestURL.Query()
	query.Set("environmentId", e.cfg.EnvironmentID)
	requestURL.RawQuery = query.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
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

	var payload DeploymentEnvResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode deployment env: %w", err)
	}
	return payload.InterpolationEnv, nil
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

	return e.reloadActiveCaddyConfig(ctx)
}

func (e *Engine) clearActiveCaddySnippet(ctx context.Context) error {
	snippetPath := filepath.Join(filepath.Dir(e.cfg.CaddyfilePath), "sites", SafeEnvironmentFilePart(e.cfg.EnvironmentID)+".caddy")
	if err := os.Remove(snippetPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove active Caddy snippet: %w", err)
	}

	root := GenerateRootCaddyfile(CaddyfileOptions{
		ACMEEmail: e.cfg.ACMEEmail,
		ACMECA:    e.cfg.ACMECA,
	})
	if err := writeFileAtomic(e.cfg.CaddyfilePath, root, 0644); err != nil {
		return fmt.Errorf("write root Caddyfile: %w", err)
	}
	return e.reloadActiveCaddyConfig(ctx)
}

func (e *Engine) reloadActiveCaddyConfig(ctx context.Context) error {
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
