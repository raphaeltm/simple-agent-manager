package server

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/container"
	"github.com/workspace/vm-agent/internal/resourcemon"
)

const (
	defaultEvictionSnapshotRuntimeName = "vm"
	evictionDockerSafePath             = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
)

type evictionWorkspaceCandidate struct {
	workspaceID        string
	labelValue         string
	runtimeVersion     string
	evictionGeneration string
}

func (s *Server) newResourceEvictionController() (*resourcemon.EvictionController, error) {
	if s.resourceGuard == nil {
		return nil, nil
	}
	return resourcemon.NewEvictionController(resourcemon.EvictionControllerConfig{
		Source:               s.resourceGuard,
		DebounceWindow:       s.config.EvictionDebounceWindow,
		SnapshotTimeout:      s.config.EvictionSnapshotTimeout,
		ResolveTimeout:       s.config.EvictionResolveTimeout,
		ResolveWorkspace:     s.resolveEvictionWorkspaceForMetric,
		SnapshotWorkspace:    s.captureEvictionSessionSnapshot,
		StopContainer:        s.stopEvictedWorkspaceContainer,
		MarkWorkspaceEvicted: s.markWorkspaceEvicted,
		NotifyEviction:       s.notifyWorkspaceEvicted,
		Logger:               slog.Default(),
	})
}

func (s *Server) captureEvictionSessionSnapshot(ctx context.Context, target resourcemon.EvictionTarget) error {
	input, err := s.evictionSessionSnapshotInput(target.WorkspaceID)
	if err != nil {
		return err
	}
	snapshotLock := s.sessionSnapshotLock(input.chatSessionID)
	if err := snapshotLock.Lock(ctx); err != nil {
		return err
	}
	defer snapshotLock.Unlock()
	// Acquire lifecycle ownership only after the snapshot queue: a capture
	// queued behind another operation must not block a newer restart claim.
	lifecycleLock := s.workspaceLifecycleLock(target.WorkspaceID)
	if err := lifecycleLock.Lock(ctx); err != nil {
		return err
	}
	defer lifecycleLock.Unlock()
	if !s.evictionTargetIsCurrent(ctx, target) {
		return fmt.Errorf("eviction target is no longer current")
	}
	// Freeze the Docker identity after both waits. The shared snapshot runner
	// must never rediscover a successor container for this eviction's snapshot.
	input.containerTarget, err = s.resolveContainerSnapshotTarget(ctx, input.runtime)
	cleanupSnapshotHelper := noopSnapshotHelperCleanup
	usingSnapshotHelper := false
	if err != nil {
		if target.Reason != resourcemon.EvictionReasonOOMKill {
			return err
		}
		input.containerTarget, cleanupSnapshotHelper, err = s.startExitedEvictionSnapshotHelper(ctx, target, input.runtime)
		if err != nil {
			return err
		}
		usingSnapshotHelper = true
	}
	defer cleanupSnapshotHelper()
	if !usingSnapshotHelper {
		if !dockerContainerIdentityMatches(input.containerTarget.containerID, target.ContainerID) {
			return fmt.Errorf("snapshot container no longer matches eviction target")
		}
		input.containerTarget.containerID = target.ContainerID
	}
	_, err = s.runSessionSnapshot(ctx, input)
	return err
}

func (s *Server) evictionSessionSnapshotInput(workspaceID string) (*sessionSnapshotHandlerInput, error) {
	if strings.TrimSpace(workspaceID) == "" {
		return nil, fmt.Errorf("workspace ID is required")
	}

	runtime, err := s.evictionWorkspaceRuntimeSnapshot(workspaceID)
	if err != nil {
		return nil, err
	}

	session, err := s.evictionAgentSession(workspaceID)
	if err != nil {
		return nil, err
	}

	chatSessionID := strings.TrimSpace(runtime.ChatSessionID)
	if chatSessionID == "" && s.config != nil && workspaceID == strings.TrimSpace(s.config.WorkspaceID) {
		chatSessionID = strings.TrimSpace(s.config.ChatSessionID)
	}
	if chatSessionID == "" {
		return nil, fmt.Errorf("workspace %s has no chat session ID for eviction snapshot", workspaceID)
	}

	callbackToken := strings.TrimSpace(runtime.CallbackToken)
	if callbackToken == "" && s.config != nil {
		callbackToken = strings.TrimSpace(s.config.CallbackToken)
	}
	if callbackToken == "" {
		return nil, fmt.Errorf("workspace %s has no callback token for eviction snapshot", workspaceID)
	}

	runtimeName := defaultEvictionSnapshotRuntimeName
	if s.config != nil && s.config.IsStandaloneMode() {
		runtimeName = config.RoleStandalone
	}

	return &sessionSnapshotHandlerInput{
		workspaceID:   workspaceID,
		sessionID:     session.ID,
		chatSessionID: chatSessionID,
		runtimeName:   runtimeName,
		runtime:       runtime,
		callbackToken: callbackToken,
		acpSessionID:  strings.TrimSpace(session.AcpSessionID),
		agentType:     strings.TrimSpace(session.AgentType),
		background:    false,
	}, nil
}

func (s *Server) evictionWorkspaceRuntimeSnapshot(workspaceID string) (*WorkspaceRuntime, error) {
	s.workspaceMu.RLock()
	defer s.workspaceMu.RUnlock()

	runtime, ok := s.workspaces[workspaceID]
	if !ok || runtime == nil {
		return nil, errWorkspaceRuntimeNotFound
	}
	copy := *runtime
	return &copy, nil
}

func (s *Server) evictionAgentSession(workspaceID string) (agentsessions.Session, error) {
	if s.agentSessions == nil {
		return agentsessions.Session{}, fmt.Errorf("workspace %s has no agent session manager", workspaceID)
	}

	sessions := s.agentSessions.List(workspaceID)
	for _, session := range sessions {
		if session.Status == agentsessions.StatusRunning {
			return session, nil
		}
	}
	for _, session := range sessions {
		if session.Status == agentsessions.StatusSuspended {
			return session, nil
		}
	}
	for _, session := range sessions {
		if session.Status == agentsessions.StatusError {
			return session, nil
		}
	}
	return agentsessions.Session{}, fmt.Errorf("workspace %s has no active agent session for eviction snapshot", workspaceID)
}

func (s *Server) resolveEvictionWorkspaceForMetric(ctx context.Context, metric resourcemon.ContainerMetric) (resourcemon.WorkspaceContainer, bool) {
	candidates := s.evictionWorkspaceCandidates()
	for _, candidate := range candidates {
		containerID, err := s.latestEvictionContainer(ctx, candidate.labelValue)
		if err != nil {
			continue
		}
		if !dockerContainerIdentityMatches(containerID, metric.ID) {
			continue
		}
		return resourcemon.WorkspaceContainer{
			WorkspaceID:        candidate.workspaceID,
			ContainerID:        containerID,
			ContainerName:      metric.Name,
			RuntimeVersion:     candidate.runtimeVersion,
			EvictionGeneration: candidate.evictionGeneration,
		}, true
	}
	return resourcemon.WorkspaceContainer{}, false
}

func (s *Server) evictionWorkspaceCandidates() []evictionWorkspaceCandidate {
	s.workspaceMu.RLock()
	defer s.workspaceMu.RUnlock()

	candidates := make([]evictionWorkspaceCandidate, 0, len(s.workspaces))
	for workspaceID, runtime := range s.workspaces {
		if runtime == nil {
			continue
		}
		if runtime.Status != "running" && runtime.Status != "recovery" {
			continue
		}
		labelValue := strings.TrimSpace(runtime.ContainerLabelValue)
		if labelValue == "" {
			continue
		}
		candidates = append(candidates, evictionWorkspaceCandidate{
			workspaceID:        workspaceID,
			labelValue:         labelValue,
			runtimeVersion:     runtime.UpdatedAt.UTC().Format(time.RFC3339Nano),
			evictionGeneration: runtime.EvictionGeneration,
		})
	}
	return candidates
}

func dockerContainerIdentityMatches(a, b string) bool {
	a = strings.TrimSpace(a)
	b = strings.TrimSpace(b)
	if a == "" || b == "" {
		return false
	}
	return a == b || strings.HasPrefix(a, b) || strings.HasPrefix(b, a)
}

// latestEvictionContainer includes exited containers, because a die/137 event
// is delivered after its victim disappeared from running-only discovery. Docker
// applies the label filter before the latest limit; a rebuilt container wins.
func (s *Server) latestEvictionContainer(ctx context.Context, labelValue string) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	queryCtx, cancel := context.WithTimeout(ctx, s.config.EvictionResolveTimeout)
	defer cancel()
	filter := "label=" + s.config.ContainerLabelKey + "=" + labelValue
	cmd := exec.CommandContext(queryCtx, container.DockerCLIPath(), "ps", "--all", "--no-trunc", "--latest", "--filter", filter, "--format", "{{.ID}}")
	cmd.WaitDelay = s.config.EvictionResolveTimeout
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("resolve eviction container: %w", err)
	}
	id := strings.TrimSpace(string(output))
	if id == "" {
		return "", nil
	}
	if !isValidContainerID(id) {
		return "", fmt.Errorf("eviction container identity unavailable")
	}
	return id, nil
}

func (s *Server) evictionTargetIsCurrent(ctx context.Context, target resourcemon.EvictionTarget) bool {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, s.config.EvictionResolveTimeout)
	defer cancel()
	resolved, ok := s.resolveEvictionWorkspaceForMetric(ctx, resourcemon.ContainerMetric{ID: target.ContainerID})
	if !ok || resolved.WorkspaceID != target.WorkspaceID || resolved.RuntimeVersion != target.RuntimeVersion || resolved.EvictionGeneration != target.EvictionGeneration {
		return false
	}
	if target.Event.Type == resourcemon.PressureEventContainerOOM && !target.Event.OccurredAt.IsZero() &&
		!s.evictionEventMatchesContainerStart(ctx, target) {
		return false
	}
	s.workspaceMu.RLock()
	defer s.workspaceMu.RUnlock()
	runtime := s.workspaces[target.WorkspaceID]
	return runtime != nil && (runtime.Status == "running" || runtime.Status == "recovery") &&
		runtime.UpdatedAt.UTC().Format(time.RFC3339Nano) == target.RuntimeVersion
}

// Docker start can reuse an ID. Reject an OOM event from its previous run.
func (s *Server) evictionEventMatchesContainerStart(ctx context.Context, target resourcemon.EvictionTarget) bool {
	queryCtx, cancel := context.WithTimeout(ctx, s.config.EvictionResolveTimeout)
	defer cancel()
	cmd := exec.CommandContext(queryCtx, container.DockerCLIPath(), "inspect", "--format", "{{.State.StartedAt}}", target.ContainerID)
	cmd.WaitDelay = s.config.EvictionResolveTimeout
	output, err := cmd.Output()
	if err != nil {
		return false
	}
	startedAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(string(output)))
	return err == nil && !startedAt.After(target.Event.OccurredAt)
}

func (s *Server) stopEvictedWorkspaceContainer(ctx context.Context, target resourcemon.EvictionTarget) error {
	if ctx == nil {
		ctx = context.Background()
	}
	lockCtx, lockCancel := context.WithTimeout(ctx, s.config.EvictionResolveTimeout)
	defer lockCancel()
	lifecycleLock := s.workspaceLifecycleLock(target.WorkspaceID)
	if err := lifecycleLock.Lock(lockCtx); err != nil {
		return err
	}
	defer lifecycleLock.Unlock()
	containerID := strings.TrimSpace(target.ContainerID)
	if !isValidContainerID(containerID) {
		return fmt.Errorf("invalid eviction container ID")
	}
	// Snapshotting may take minutes. Never stop a replacement or mark a newly
	// restarted runtime based on the target selected before that snapshot.
	if !s.evictionTargetIsCurrent(ctx, target) {
		return fmt.Errorf("eviction target is no longer current")
	}
	// Write-ahead intent blocks automatic recovery even if the agent exits
	// after Docker stops but before the completed eviction can be committed.
	if err := s.prepareWorkspaceEvictionStop(ctx, target); err != nil {
		return err
	}
	return s.stopEvictionContainer(ctx, containerID)
}

func (s *Server) stopEvictionContainer(ctx context.Context, containerID string) error {
	stopTimeout := s.config.EvictionDockerStopTimeout
	stopCtx, cancel := context.WithTimeout(ctx, evictionDockerStopCommandTimeout(stopTimeout))
	defer cancel()

	stopSeconds := int((stopTimeout + time.Second - 1) / time.Second)
	if stopSeconds < 1 {
		stopSeconds = 1
	}

	cmd := exec.CommandContext(stopCtx, container.DockerCLIPath(), evictionDockerStopArgs(stopSeconds, containerID)...)
	cmd.Env = append(os.Environ(), evictionDockerSafePath)
	cmd.WaitDelay = stopTimeout
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker stop %s failed: %w: %s", containerID, err, strings.TrimSpace(string(output)))
	}
	return nil
}

func evictionDockerStopArgs(stopSeconds int, containerID string) []string {
	return []string{"stop", "--time", strconv.Itoa(stopSeconds), containerID}
}

func evictionDockerStopCommandTimeout(stopTimeout time.Duration) time.Duration {
	return stopTimeout + stopTimeout/2
}

func (s *Server) markWorkspaceEvicted(result resourcemon.EvictionResult) bool {
	workspaceID := result.Target.WorkspaceID
	if workspaceID == "" || !result.ContainerStopped || s.store == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.config.HTTPCallbackTimeout)
	defer cancel()
	lifecycleLock := s.workspaceLifecycleLock(workspaceID)
	if err := lifecycleLock.Lock(ctx); err != nil {
		return false
	}
	defer lifecycleLock.Unlock()
	runtime, err := s.evictionWorkspaceRuntimeSnapshot(workspaceID)
	if err != nil || (runtime.Status != "running" && runtime.Status != "recovery") ||
		runtime.UpdatedAt.UTC().Format(time.RFC3339Nano) != result.Target.RuntimeVersion || runtime.EvictionGeneration != result.Target.EvictionGeneration {
		return false
	}
	if err := s.writeWorkspaceMetadata(runtime); err != nil {
		slog.Error("Failed to persist eviction workspace metadata", "workspaceId", workspaceID, "error", err)
		return false
	}
	delivery := s.workspaceEvictionDelivery(result)
	applied, err := s.store.RecordWorkspaceEviction(ctx, delivery)
	if err != nil || !applied {
		slog.Error("Failed to durably finalize workspace eviction", "workspaceId", workspaceID, "error", err)
		return false
	}
	return s.finishLocalWorkspaceEviction(result)
}

// Caller holds the workspace lifecycle lock. Durable state is already committed.
func (s *Server) finishLocalWorkspaceEviction(result resourcemon.EvictionResult) bool {
	workspaceID := result.Target.WorkspaceID
	// The durable marker and delivery are committed before local state changes.
	// Restart/rebuild claims share the lifecycle lock, never the global mutex.
	s.workspaceMu.Lock()
	current := s.workspaces[workspaceID]
	if current == nil || current.EvictionGeneration != result.Target.EvictionGeneration {
		s.workspaceMu.Unlock()
		return true // Persisted intent remains authoritative after agent restart.
	}
	current.Status = "evicted"
	current.ProvisioningActive = false
	current.ReadyCallbackPending = false
	current.UpdatedAt = nowUTC()
	ptyManager := current.PTY
	s.workspaceMu.Unlock()
	if ptyManager != nil {
		ptyManager.CloseAllSessions()
	}

	if s.agentSessions != nil {
		for _, session := range s.agentSessions.List(workspaceID) {
			if session.Status == agentsessions.StatusStopped {
				continue
			}
			_ = s.agentSessions.MarkError(workspaceID, session.ID, session.AgentType, evictionSessionErrorMessage(result.Target.Reason))
		}
	}

	s.stopPortScanner(workspaceID)
	s.stopSessionHostsForWorkspace(workspaceID)
	s.appendNodeEvent(workspaceID, "warn", "workspace.evicted", "Workspace evicted due to resource pressure", map[string]interface{}{
		"reason":           string(result.Target.Reason),
		"containerId":      result.Target.ContainerID,
		"containerName":    result.Target.ContainerName,
		"snapshotCaptured": result.SnapshotCaptured,
		"containerStopped": result.ContainerStopped,
		"snapshotError":    errorMessage(result.SnapshotError),
		"containerStopErr": errorMessage(result.ContainerStopError),
	})
	return true
}

func evictionSessionErrorMessage(reason resourcemon.EvictionReason) string {
	switch reason {
	case resourcemon.EvictionReasonOOMKill:
		return "workspace evicted after container OOM"
	default:
		return "workspace evicted due to memory pressure"
	}
}

func (s *Server) projectIDForEviction(workspaceID string) string {
	if runtime, ok := s.getWorkspaceRuntime(workspaceID); ok {
		if projectID := strings.TrimSpace(runtime.ProjectID); projectID != "" {
			return projectID
		}
	}
	if s.config != nil && workspaceID == strings.TrimSpace(s.config.WorkspaceID) {
		return strings.TrimSpace(s.config.ProjectID)
	}
	return ""
}

func errorMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
