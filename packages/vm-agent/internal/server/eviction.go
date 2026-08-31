package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
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
	workspaceID string
	labelValue  string
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
	_, err = s.captureSessionSnapshot(ctx, input)
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
		containerID, err := container.FindContainerByLabel(ctx, s.config.ContainerLabelKey, candidate.labelValue)
		if err != nil {
			continue
		}
		if !dockerContainerIdentityMatches(containerID, metric.ID) {
			continue
		}
		return resourcemon.WorkspaceContainer{
			WorkspaceID:   candidate.workspaceID,
			ContainerID:   containerID,
			ContainerName: metric.Name,
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
			workspaceID: workspaceID,
			labelValue:  labelValue,
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

func (s *Server) stopEvictedWorkspaceContainer(ctx context.Context, target resourcemon.EvictionTarget) error {
	if ctx == nil {
		ctx = context.Background()
	}
	containerID := strings.TrimSpace(target.ContainerID)
	if containerID == "" {
		resolvedID, _, _, err := s.resolveContainerForWorkspace(target.WorkspaceID)
		if err != nil {
			return err
		}
		containerID = resolvedID
	}
	if !isValidContainerID(containerID) {
		return fmt.Errorf("invalid container ID format: %q", containerID)
	}

	stopTimeout := s.config.EvictionDockerStopTimeout
	stopCtx, cancel := context.WithTimeout(ctx, evictionDockerStopCommandTimeout(stopTimeout))
	defer cancel()

	stopSeconds := int((stopTimeout + time.Second - 1) / time.Second)
	if stopSeconds < 1 {
		stopSeconds = 1
	}

	cmd := exec.CommandContext(stopCtx, "docker", evictionDockerStopArgs(stopSeconds, containerID)...)
	cmd.Env = append(os.Environ(), evictionDockerSafePath)
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

func (s *Server) markWorkspaceEvicted(result resourcemon.EvictionResult) {
	workspaceID := result.Target.WorkspaceID
	if workspaceID == "" {
		return
	}

	s.workspaceMu.Lock()
	if runtime, ok := s.workspaces[workspaceID]; ok && runtime != nil {
		if runtime.PTY != nil {
			runtime.PTY.CloseAllSessions()
		}
		runtime.Status = "evicted"
		runtime.ProvisioningActive = false
		runtime.ReadyCallbackPending = false
		runtime.UpdatedAt = nowUTC()
	}
	s.workspaceMu.Unlock()

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
}

func evictionSessionErrorMessage(reason resourcemon.EvictionReason) string {
	switch reason {
	case resourcemon.EvictionReasonOOMKill:
		return "workspace evicted after container OOM"
	default:
		return "workspace evicted due to memory pressure"
	}
}

func (s *Server) notifyWorkspaceEvicted(ctx context.Context, result resourcemon.EvictionResult) error {
	if s.controlPlaneCallbacksStopped() {
		slog.Info("Workspace eviction callback skipped after terminal callback state",
			"workspaceId", result.Target.WorkspaceID,
			"reason", result.Target.Reason,
		)
		return nil
	}
	if s.config == nil || strings.TrimSpace(s.config.ControlPlaneURL) == "" {
		return fmt.Errorf("control plane URL is not configured")
	}

	projectID := s.projectIDForEviction(result.Target.WorkspaceID)
	if projectID == "" {
		return fmt.Errorf("workspace %s has no project ID for eviction callback", result.Target.WorkspaceID)
	}

	token := s.callbackTokenForWorkspace(result.Target.WorkspaceID)
	if token == "" {
		return fmt.Errorf("workspace %s has no callback token for eviction callback", result.Target.WorkspaceID)
	}

	endpoint := strings.TrimRight(s.config.ControlPlaneURL, "/") +
		"/api/projects/" + url.PathEscape(projectID) +
		"/workspaces/" + url.PathEscape(result.Target.WorkspaceID) +
		"/eviction"

	body := map[string]interface{}{
		"nodeId":           strings.TrimSpace(s.config.NodeID),
		"workspaceId":      result.Target.WorkspaceID,
		"reason":           string(result.Target.Reason),
		"snapshotCaptured": result.SnapshotCaptured,
		"containerStopped": result.ContainerStopped,
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.controlPlaneHTTPClient(0).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	responseBody := readBoundedResponseBody(resp.Body)

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		slog.Info("Workspace eviction callback sent",
			"workspaceId", result.Target.WorkspaceID,
			"projectId", projectID,
			"reason", result.Target.Reason,
			"snapshotCaptured", result.SnapshotCaptured,
			"containerStopped", result.ContainerStopped,
		)
		return nil
	}
	if isTerminalControlPlaneCallbackStatus(resp.StatusCode) {
		slog.Info("Workspace eviction callback returned terminal status",
			"workspaceId", result.Target.WorkspaceID,
			"projectId", projectID,
			"statusCode", resp.StatusCode,
			"responseBody", responseBody,
		)
		return nil
	}

	return fmt.Errorf("workspace eviction callback returned HTTP %d: %s", resp.StatusCode, responseBody)
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
