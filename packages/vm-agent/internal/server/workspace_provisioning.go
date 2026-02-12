package server

import (
	"context"
	"fmt"
	"log"
	"strings"

	"github.com/workspace/vm-agent/internal/bootstrap"
)

func (s *Server) callbackTokenForWorkspace(workspaceID string) string {
	if runtime, ok := s.getWorkspaceRuntime(workspaceID); ok {
		if token := strings.TrimSpace(runtime.CallbackToken); token != "" {
			return token
		}
	}

	return strings.TrimSpace(s.config.CallbackToken)
}

func (s *Server) provisionWorkspaceRuntime(ctx context.Context, runtime *WorkspaceRuntime) error {
	if runtime == nil {
		return fmt.Errorf("workspace runtime is required")
	}

	callbackToken := strings.TrimSpace(runtime.CallbackToken)
	if callbackToken == "" {
		callbackToken = strings.TrimSpace(s.config.CallbackToken)
	}

	cfg := *s.config
	cfg.WorkspaceID = runtime.ID
	cfg.Repository = strings.TrimSpace(runtime.Repository)
	cfg.Branch = strings.TrimSpace(runtime.Branch)
	cfg.WorkspaceDir = strings.TrimSpace(runtime.WorkspaceDir)
	cfg.ContainerLabelValue = strings.TrimSpace(runtime.ContainerLabelValue)
	cfg.ContainerWorkDir = strings.TrimSpace(runtime.ContainerWorkDir)
	cfg.CallbackToken = callbackToken

	provisionCtx := ctx
	cancel := func() {}
	if s.config.BootstrapTimeout > 0 {
		provisionCtx, cancel = context.WithTimeout(ctx, s.config.BootstrapTimeout)
	}
	defer cancel()

	gitToken, err := s.fetchGitTokenForWorkspace(provisionCtx, runtime.ID, callbackToken)
	if err != nil {
		log.Printf("Workspace %s: proceeding without git token: %v", runtime.ID, err)
	}

	return bootstrap.PrepareWorkspace(provisionCtx, &cfg, bootstrap.ProvisionState{
		GitHubToken: gitToken,
	})
}
