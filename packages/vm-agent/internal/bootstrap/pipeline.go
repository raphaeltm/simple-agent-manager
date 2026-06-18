package bootstrap

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/config"
)

type StepStatus string

const (
	StepCompleted StepStatus = "completed"
	StepSkipped   StepStatus = "skipped"
	StepWarning   StepStatus = "warning"
)

type StepResult struct {
	Status  StepStatus
	Message string
	Err     error
}

type bootstrapStep struct {
	name           string
	required       bool
	startMessage   string
	successMessage string
	failureMessage string
	run            func(context.Context, *workspaceBootstrapContext) StepResult
}

type workspaceBootstrapContext struct {
	cfg       *config.Config
	reporter  *bootlog.Reporter
	provision ProvisionState
	bootstrap *bootstrapState

	volumeName                string
	credentialHelperHostPath  string
	repoHasDevcontainerConfig bool
	effectiveWorkspaceProfile string
	devcontainerCacheRef      string
	usedFallback              bool
	recoveryMode              bool
	readyStatus               string

	cleanup cleanupStack
}

type cleanupAction struct {
	name string
	run  func()
}

type cleanupStack struct {
	actions  []cleanupAction
	disarmed bool
}

func (s *cleanupStack) register(name string, run func()) {
	if run == nil {
		return
	}
	s.actions = append(s.actions, cleanupAction{name: name, run: run})
}

func (s *cleanupStack) disarm() {
	s.disarmed = true
}

func (s *cleanupStack) runFailureCleanup() {
	if s.disarmed {
		return
	}
	for i := len(s.actions) - 1; i >= 0; i-- {
		action := s.actions[i]
		func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					slog.Warn("Bootstrap cleanup panicked", "name", action.name, "panic", recovered)
				}
			}()
			action.run()
		}()
	}
}

func runBootstrapPlan(ctx context.Context, plan []bootstrapStep, bootstrapCtx *workspaceBootstrapContext) error {
	for _, step := range plan {
		result := runBootstrapStep(ctx, step, bootstrapCtx)
		if result.Err == nil || !step.required {
			continue
		}
		bootstrapCtx.cleanup.runFailureCleanup()
		return result.Err
	}
	return nil
}

func runBootstrapStep(ctx context.Context, step bootstrapStep, bootstrapCtx *workspaceBootstrapContext) StepResult {
	if step.run == nil {
		return StepResult{Status: StepSkipped}
	}

	if step.name != "" && step.startMessage != "" {
		bootstrapCtx.reporter.Log(step.name, "started", step.startMessage)
	}

	result := step.run(ctx, bootstrapCtx)
	if result.Status == "" {
		result.Status = StepCompleted
	}

	if result.Err != nil {
		message := result.Message
		if message == "" {
			message = step.failureMessage
		}
		if message == "" {
			message = result.Err.Error()
		}
		if step.name != "" {
			bootstrapCtx.reporter.Log(step.name, "failed", message, result.Err.Error())
		}
		return result
	}

	if result.Status == StepWarning {
		message := result.Message
		if message == "" {
			message = step.failureMessage
		}
		if message != "" && step.name != "" {
			bootstrapCtx.reporter.Log(step.name, "failed", message)
		}
		return result
	}

	if result.Status == StepSkipped {
		return result
	}

	message := result.Message
	if message == "" {
		message = step.successMessage
	}
	if step.name != "" && message != "" {
		bootstrapCtx.reporter.Log(step.name, "completed", message)
	}
	return result
}

func okResult() StepResult {
	return StepResult{Status: StepCompleted}
}

func errResult(err error) StepResult {
	return StepResult{Status: StepCompleted, Err: err}
}

func warningResult(message string, err error) StepResult {
	return StepResult{Status: StepWarning, Message: message, Err: err}
}

func bootstrapTokenPlan() []bootstrapStep {
	return []bootstrapStep{
		loadOrRedeemBootstrapStateStep(),
		validateCallbackTokenStep(),
		ensureWorkspaceVolumeStep(),
		ensureRepositoryStep(),
		writeCredentialHelperStep(),
		startBootstrapDevcontainerStep(),
		injectAptConfigStep(),
		ensureGitHubCLIStep(),
		ensureGitCredentialHelperStep(),
		ensureGitIdentityStep(),
		ensureSAMEnvironmentStep(),
		resolveBootstrapReadyStatusStep(),
		disarmCredentialCleanupStep(),
		markWorkspaceReadyStep(),
	}
}

func prepareWorkspacePlan() []bootstrapStep {
	return []bootstrapStep{
		useProvisionStateStep(),
		ensureWorkspaceVolumeStep(),
		ensureRepositoryStep(),
		detectRepositoryDevcontainerStep(),
		resolveEffectiveWorkspaceProfileStep(),
		writeCredentialHelperStep(),
		prepareDevcontainerCacheStep(),
		startPrepareWorkspaceDevcontainerStep(),
		injectAptConfigStep(),
		ensureGitHubCLIStep(),
		ensureGitCredentialHelperStep(),
		ensureGitIdentityStep(),
		ensureSAMEnvironmentStep(),
		ensureProjectRuntimeAssetsStep(),
		disarmCredentialCleanupStep(),
		markWorkspaceReadyStep(),
	}
}

func loadOrRedeemBootstrapStateStep() bootstrapStep {
	return bootstrapStep{
		required: true,
		run: func(ctx context.Context, b *workspaceBootstrapContext) StepResult {
			state, err := loadState(b.cfg.BootstrapStatePath)
			if err != nil {
				return errResult(fmt.Errorf("failed to load bootstrap state: %w", err))
			}
			if state != nil {
				if state.WorkspaceID != b.cfg.WorkspaceID {
					return errResult(fmt.Errorf("bootstrap state workspace mismatch: expected %s, found %s", b.cfg.WorkspaceID, state.WorkspaceID))
				}
				slog.Info("Using cached bootstrap state", "path", b.cfg.BootstrapStatePath)
				b.bootstrap = state
				b.cfg.CallbackToken = state.CallbackToken
				b.reporter.SetToken(state.CallbackToken)
				return okResult()
			}

			b.reporter.Log("bootstrap_redeem", "started", "Redeeming bootstrap credentials")
			state, err = redeemBootstrapTokenWithRetry(ctx, b.cfg)
			if err != nil {
				return errResult(err)
			}
			b.bootstrap = state
			b.cfg.CallbackToken = state.CallbackToken
			b.reporter.SetToken(state.CallbackToken)
			b.reporter.Log("bootstrap_redeem", "completed", "Bootstrap credentials redeemed")
			if err := saveState(b.cfg.BootstrapStatePath, state); err != nil {
				return errResult(fmt.Errorf("failed to persist bootstrap state: %w", err))
			}
			return okResult()
		},
	}
}

func useProvisionStateStep() bootstrapStep {
	return bootstrapStep{
		required: true,
		run: func(_ context.Context, b *workspaceBootstrapContext) StepResult {
			b.bootstrap = &bootstrapState{
				WorkspaceID:   b.cfg.WorkspaceID,
				CallbackToken: b.cfg.CallbackToken,
				GitHubToken:   strings.TrimSpace(b.provision.GitHubToken),
				GitUserName:   strings.TrimSpace(b.provision.GitUserName),
				GitUserEmail:  strings.TrimSpace(b.provision.GitUserEmail),
				GitHubID:      strings.TrimSpace(b.provision.GitHubID),
			}
			return okResult()
		},
	}
}

func validateCallbackTokenStep() bootstrapStep {
	return bootstrapStep{
		required: true,
		run: func(_ context.Context, b *workspaceBootstrapContext) StepResult {
			if b.cfg.CallbackToken == "" {
				return errResult(errors.New("callback token is missing after bootstrap"))
			}
			return okResult()
		},
	}
}

func ensureWorkspaceVolumeStep() bootstrapStep {
	return bootstrapStep{
		name:           "volume_create",
		required:       true,
		startMessage:   "Creating workspace volume",
		successMessage: "Workspace volume ready",
		failureMessage: "Volume creation failed",
		run: func(ctx context.Context, b *workspaceBootstrapContext) StepResult {
			if !b.cfg.ContainerMode {
				return StepResult{Status: StepSkipped}
			}
			volumeName, err := ensureVolumeReady(ctx, b.cfg.WorkspaceID)
			if err != nil {
				return errResult(err)
			}
			b.volumeName = volumeName
			return okResult()
		},
	}
}

func ensureRepositoryStep() bootstrapStep {
	return bootstrapStep{
		name:           "git_clone",
		required:       true,
		startMessage:   "Cloning repository",
		successMessage: "Repository cloned",
		failureMessage: "Repository clone failed",
		run: func(ctx context.Context, b *workspaceBootstrapContext) StepResult {
			return errResult(ensureRepositoryReady(ctx, b.cfg, b.bootstrap, b.volumeName))
		},
	}
}

func detectRepositoryDevcontainerStep() bootstrapStep {
	return bootstrapStep{
		required: true,
		run: func(_ context.Context, b *workspaceBootstrapContext) StepResult {
			b.repoHasDevcontainerConfig = hasDevcontainerConfig(b.cfg.WorkspaceDir)
			return okResult()
		},
	}
}

func resolveEffectiveWorkspaceProfileStep() bootstrapStep {
	return bootstrapStep{
		required: true,
		run: func(_ context.Context, b *workspaceBootstrapContext) StepResult {
			if b.provision.Lightweight || (b.provision.DevcontainerConfigName == "" && !b.repoHasDevcontainerConfig) {
				b.effectiveWorkspaceProfile = "lightweight"
			}
			return okResult()
		},
	}
}

func writeCredentialHelperStep() bootstrapStep {
	return bootstrapStep{
		name:           "git_credential_helper",
		required:       false,
		failureMessage: "Credential helper setup failed — git auth may be unavailable in lifecycle hooks",
		run: func(_ context.Context, b *workspaceBootstrapContext) StepResult {
			credHelperHostPath, err := writeCredentialHelperToHost(b.cfg)
			if err != nil {
				slog.Warn("Failed to write credential helper to host (non-fatal)", "error", err)
				return warningResult("Credential helper setup failed — git auth may be unavailable in lifecycle hooks", err)
			}
			b.credentialHelperHostPath = credHelperHostPath
			if credHelperHostPath != "" {
				b.cleanup.register("credential helper", func() {
					RemoveCredentialHelperFromHost(b.cfg.WorkspaceID)
				})
			}
			return StepResult{Status: StepSkipped}
		},
	}
}

func prepareDevcontainerCacheStep() bootstrapStep {
	return bootstrapStep{
		required: false,
		run: func(ctx context.Context, b *workspaceBootstrapContext) StepResult {
			if !b.cfg.DevcontainerCacheEnabled || b.provision.Lightweight || !b.repoHasDevcontainerConfig {
				return StepResult{Status: StepSkipped}
			}
			cacheRef, err := prepareDevcontainerCache(ctx, b.cfg, b.bootstrap.GitHubToken, b.provision.DevcontainerConfigName)
			if err != nil {
				slog.Warn("Cache registry login failed (caching disabled for this build)", "registry", b.cfg.DevcontainerCacheRegistry, "error", err)
				return StepResult{Status: StepWarning, Message: "Devcontainer cache unavailable"}
			}
			b.devcontainerCacheRef = cacheRef
			if cacheRef != "" {
				b.reporter.Log("devcontainer_cache", "started", "Checking devcontainer cache")
			}
			return okResult()
		},
	}
}

func startBootstrapDevcontainerStep() bootstrapStep {
	return bootstrapStep{
		name:           "devcontainer_up",
		required:       true,
		startMessage:   "Building devcontainer",
		failureMessage: "Devcontainer build failed",
		run: func(ctx context.Context, b *workspaceBootstrapContext) StepResult {
			b.reporter.Log("devcontainer_wait", "started", "Waiting for devcontainer CLI")
			usedFallback, err := ensureDevcontainerReady(ctx, b.cfg, b.volumeName, b.credentialHelperHostPath, "", "")
			if err != nil {
				return errResult(err)
			}
			b.usedFallback = usedFallback
			if usedFallback {
				return StepResult{Status: StepCompleted, Message: "Devcontainer ready (fallback to default image)"}
			}
			return StepResult{Status: StepCompleted, Message: "Devcontainer ready"}
		},
	}
}

func startPrepareWorkspaceDevcontainerStep() bootstrapStep {
	return bootstrapStep{
		name:           "devcontainer_up",
		required:       true,
		failureMessage: "Devcontainer build failed",
		run: func(ctx context.Context, b *workspaceBootstrapContext) StepResult {
			if b.provision.Lightweight {
				b.reporter.Log("devcontainer_up", "started", "Starting lightweight container (skipping devcontainer build)")
				slog.Info("Lightweight mode: forcing fallback image, skipping devcontainer build", "workspaceID", b.cfg.WorkspaceID)
				usedFallback, err := ensureDevcontainerFallback(ctx, b.cfg, b.volumeName, b.credentialHelperHostPath)
				if err != nil {
					return StepResult{Err: err, Message: "Lightweight container startup failed"}
				}
				b.usedFallback = usedFallback
				return StepResult{Status: StepCompleted, Message: "Lightweight container ready"}
			}

			b.reporter.Log("devcontainer_up", "started", "Building devcontainer")
			usedFallback, err := ensureDevcontainerReady(ctx, b.cfg, b.volumeName, b.credentialHelperHostPath, b.provision.DevcontainerConfigName, b.devcontainerCacheRef)
			if err != nil {
				return errResult(err)
			}
			b.usedFallback = usedFallback
			b.recoveryMode = usedFallback
			if markerFound, markerErr := hasBuildErrorMarker(b.cfg); markerErr != nil {
				slog.Warn("Failed to inspect build error marker", "workspaceID", b.cfg.WorkspaceID, "error", markerErr)
			} else if markerFound {
				b.recoveryMode = true
			}
			if usedFallback {
				return StepResult{Status: StepCompleted, Message: "Devcontainer ready (fallback to default image)"}
			}
			return StepResult{Status: StepCompleted, Message: "Devcontainer ready"}
		},
	}
}

func injectAptConfigStep() bootstrapStep {
	return bootstrapStep{
		required: false,
		run: func(ctx context.Context, b *workspaceBootstrapContext) StepResult {
			containerID, findErr := findDevcontainerID(ctx, b.cfg)
			if findErr != nil {
				slog.Debug("Could not find devcontainer for apt config injection (non-fatal)", "error", findErr)
				return StepResult{Status: StepSkipped}
			}
			injectAptRetryConfig(ctx, containerID)
			injectAptMirrorConfig(ctx, b.cfg, containerID)
			return okResult()
		},
	}
}

func ensureGitHubCLIStep() bootstrapStep {
	return bootstrapStep{
		name:           "gh_cli",
		required:       false,
		startMessage:   "Checking GitHub CLI availability",
		successMessage: "GitHub CLI available",
		failureMessage: "GitHub CLI install failed (non-fatal)",
		run: func(ctx context.Context, b *workspaceBootstrapContext) StepResult {
			if err := ensureGitHubCLI(ctx, b.cfg); err != nil {
				slog.Warn("GitHub CLI install failed (non-fatal)", "error", err)
				return warningResult("GitHub CLI install failed (non-fatal)", err)
			}
			return okResult()
		},
	}
}

func ensureGitCredentialHelperStep() bootstrapStep {
	return bootstrapStep{
		name:           "git_creds",
		required:       true,
		startMessage:   "Configuring git credentials",
		successMessage: "Git credentials configured",
		failureMessage: "Git credential setup failed",
		run: func(ctx context.Context, b *workspaceBootstrapContext) StepResult {
			return errResult(ensureGitCredentialHelper(ctx, b.cfg))
		},
	}
}

func ensureGitIdentityStep() bootstrapStep {
	return bootstrapStep{
		name:           "git_identity",
		required:       true,
		startMessage:   "Configuring git identity",
		successMessage: "Git identity configured",
		failureMessage: "Git identity setup failed",
		run: func(ctx context.Context, b *workspaceBootstrapContext) StepResult {
			return errResult(ensureGitIdentity(ctx, b.cfg, b.bootstrap))
		},
	}
}

func ensureSAMEnvironmentStep() bootstrapStep {
	return bootstrapStep{
		name:           "sam_env",
		required:       false,
		startMessage:   "Configuring SAM environment",
		successMessage: "SAM environment configured",
		failureMessage: "SAM environment setup failed",
		run: func(ctx context.Context, b *workspaceBootstrapContext) StepResult {
			if err := ensureSAMEnvironment(ctx, b.cfg, b.bootstrap.GitHubToken); err != nil {
				slog.Warn("SAM environment setup failed (non-fatal)", "error", err)
				return warningResult("SAM environment setup failed", err)
			}
			return okResult()
		},
	}
}

func ensureProjectRuntimeAssetsStep() bootstrapStep {
	return bootstrapStep{
		required: true,
		run: func(ctx context.Context, b *workspaceBootstrapContext) StepResult {
			return errResult(ensureProjectRuntimeAssets(ctx, b.cfg, b.provision.ProjectEnvVars, b.provision.ProjectFiles))
		},
	}
}

func resolveBootstrapReadyStatusStep() bootstrapStep {
	return bootstrapStep{
		required: true,
		run: func(_ context.Context, b *workspaceBootstrapContext) StepResult {
			readyStatus := workspaceReadyStatusRunning
			if recovery, recoveryErr := hasBuildErrorMarker(b.cfg); recoveryErr != nil {
				slog.Warn("Failed to inspect build error marker", "workspaceID", b.cfg.WorkspaceID, "error", recoveryErr)
			} else if recovery {
				readyStatus = workspaceReadyStatusRecovery
			}
			if b.usedFallback {
				readyStatus = workspaceReadyStatusRecovery
			}
			b.readyStatus = readyStatus
			return okResult()
		},
	}
}

func disarmCredentialCleanupStep() bootstrapStep {
	return bootstrapStep{
		required: true,
		run: func(_ context.Context, b *workspaceBootstrapContext) StepResult {
			b.cleanup.disarm()
			return okResult()
		},
	}
}

func markWorkspaceReadyStep() bootstrapStep {
	return bootstrapStep{
		name:           "workspace_ready",
		required:       true,
		startMessage:   "Marking workspace ready",
		successMessage: "Workspace is ready",
		failureMessage: "Failed to mark workspace ready",
		run: func(ctx context.Context, b *workspaceBootstrapContext) StepResult {
			readyStatus := b.readyStatus
			if readyStatus == "" {
				readyStatus = workspaceReadyStatusRunning
				if b.recoveryMode {
					readyStatus = workspaceReadyStatusRecovery
				}
			}
			if err := markWorkspaceReady(ctx, b.cfg, readyStatus, b.effectiveWorkspaceProfile); err != nil {
				return errResult(&CallbackError{Err: err, Status: readyStatus})
			}
			return okResult()
		},
	}
}
