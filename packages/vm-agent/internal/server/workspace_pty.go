package server

// PTY manager and devcontainer resolver construction for workspace runtimes.

import (
	"context"
	"fmt"
	"strings"

	"github.com/workspace/vm-agent/internal/container"
	"github.com/workspace/vm-agent/internal/pty"
)

func (s *Server) newPTYManagerForWorkspace(
	workspaceID,
	workspaceDir,
	containerWorkDir,
	containerLabelValue,
	containerUser string,
) *pty.Manager {
	workDir := workspaceDir
	if s.config.ContainerMode {
		workDir = containerWorkDir
	}
	resolvedContainerUser := strings.TrimSpace(containerUser)
	if resolvedContainerUser == "" {
		resolvedContainerUser = strings.TrimSpace(s.config.ContainerUser)
	}

	config := pty.ManagerConfig{
		DefaultShell:       s.config.DefaultShell,
		DefaultRows:        s.config.DefaultRows,
		DefaultCols:        s.config.DefaultCols,
		WorkDir:            workDir,
		ContainerResolver:  s.ptyManagerContainerResolverForLabel(containerLabelValue),
		ContainerUser:      resolvedContainerUser,
		GracePeriod:        s.config.PTYOrphanGracePeriod,
		BufferSize:         s.config.PTYOutputBufferSize,
		SessionIDMaxLength: s.config.TerminalSessionIDMaxLength,
		CloseGrace:         s.config.PTYCloseGracePeriod,
	}

	manager := pty.NewManager(config)
	if s.shouldReusePrimaryPTYManager(workspaceID, workspaceDir, containerWorkDir, containerLabelValue) {
		return s.ptyManager
	}

	return manager
}

func (s *Server) shouldReusePrimaryPTYManager(workspaceID, workspaceDir, containerWorkDir, containerLabelValue string) bool {
	if s == nil || s.ptyManager == nil {
		return false
	}

	// Preserve compatibility with legacy single-workspace host mode.
	if !s.config.ContainerMode && len(s.workspaces) == 0 {
		return true
	}

	configuredWorkspaceID := strings.TrimSpace(s.config.WorkspaceID)
	if configuredWorkspaceID == "" || strings.TrimSpace(workspaceID) != configuredWorkspaceID {
		return false
	}

	expectedWorkspaceDir := strings.TrimSpace(s.workspaceDirForRuntime(configuredWorkspaceID))
	if expectedWorkspaceDir == "" {
		expectedWorkspaceDir = "/workspace"
	}
	if strings.TrimSpace(workspaceDir) != expectedWorkspaceDir {
		return false
	}

	if !s.config.ContainerMode {
		return true
	}

	expectedContainerLabel := strings.TrimSpace(s.config.ContainerLabelValue)
	if expectedContainerLabel == "" {
		expectedContainerLabel = expectedWorkspaceDir
	}
	if strings.TrimSpace(containerLabelValue) != expectedContainerLabel {
		return false
	}

	expectedContainerWorkDir := strings.TrimSpace(s.config.ContainerWorkDir)
	if expectedContainerWorkDir == "" {
		expectedContainerWorkDir = deriveContainerWorkDirForRepo(expectedWorkspaceDir, s.config.Repository)
	}
	if strings.TrimSpace(containerWorkDir) != expectedContainerWorkDir {
		return false
	}

	return true
}

func (s *Server) rebuildWorkspacePTYManager(runtime *WorkspaceRuntime) {
	if runtime == nil {
		return
	}
	if runtime.PTY != nil && runtime.PTY.SessionCount() > 0 {
		return
	}
	runtime.PTY = s.newPTYManagerForWorkspace(
		runtime.ID,
		strings.TrimSpace(runtime.WorkspaceDir),
		strings.TrimSpace(runtime.ContainerWorkDir),
		strings.TrimSpace(runtime.ContainerLabelValue),
		strings.TrimSpace(runtime.ContainerUser),
	)
}

// pty.Manager does not expose its resolver, so we derive from config.
func (s *Server) ptyManagerContainerResolver() pty.ContainerResolver {
	if !s.config.ContainerMode {
		return nil
	}
	return s.ptyManagerContainerResolverFromConfig()
}

func (s *Server) ptyManagerContainerResolverFromConfig() pty.ContainerResolver {
	return s.ptyManagerContainerResolverForLabel(s.config.ContainerLabelValue)
}

func (s *Server) ptyManagerContainerResolverForLabel(labelValue string) pty.ContainerResolver {
	resolver := s.ptyManagerContainerResolverForLabelContext(labelValue)
	if resolver == nil {
		return nil
	}
	return func() (string, error) {
		return resolver(context.Background())
	}
}

func (s *Server) ptyManagerContainerResolverForLabelContext(labelValue string) func(context.Context) (string, error) {
	if !s.config.ContainerMode {
		return nil
	}

	requestedLabel := strings.TrimSpace(labelValue)
	labelCandidates := []string{}
	if requestedLabel != "" {
		// Workspace-scoped lookups must be strict to avoid cross-workspace routing
		// when multiple containers share repo-derived or legacy label values.
		labelCandidates = containerLabelCandidates(requestedLabel)
	} else {
		labelCandidates = containerLabelCandidates(
			s.config.ContainerLabelValue,
			s.config.WorkspaceDir,
			"/workspace",
		)
	}
	if len(labelCandidates) == 0 {
		return nil
	}

	discoveries := make([]*container.Discovery, 0, len(labelCandidates))
	for _, candidate := range labelCandidates {
		discoveries = append(discoveries, container.NewDiscovery(container.Config{
			LabelKey:   s.config.ContainerLabelKey,
			LabelValue: candidate,
			CacheTTL:   s.config.ContainerCacheTTL,
		}))
	}

	return func(ctx context.Context) (string, error) {
		if ctx == nil {
			ctx = context.Background()
		}
		var lastErr error
		for _, discovery := range discoveries {
			containerID, err := discovery.GetContainerIDContext(ctx)
			if err == nil {
				return containerID, nil
			}
			if ctxErr := ctx.Err(); ctxErr != nil {
				return "", ctxErr
			}
			lastErr = err
		}
		if lastErr != nil {
			return "", lastErr
		}
		return "", fmt.Errorf("no container label candidates configured")
	}
}

func containerLabelCandidates(values ...string) []string {
	candidates := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		candidates = append(candidates, trimmed)
	}
	return candidates
}
