package server

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/pty"
)

// initializeBootWorkspace runs before HTTP serving and restores the durable
// eviction fence even for the legacy workspace prepopulated from node config.
func (s *Server) initializeBootWorkspace(cfg *config.Config, ptyManager *pty.Manager) error {
	if cfg.WorkspaceID != "" {
		s.workspaces[cfg.WorkspaceID] = &WorkspaceRuntime{
			ID:                  cfg.WorkspaceID,
			Repository:          strings.TrimSpace(cfg.Repository),
			Branch:              strings.TrimSpace(cfg.Branch),
			BaseBranch:          strings.TrimSpace(cfg.BaseBranch),
			Status:              "running",
			CreatedAt:           time.Now().UTC(),
			UpdatedAt:           time.Now().UTC(),
			WorkspaceDir:        strings.TrimSpace(cfg.WorkspaceDir),
			ContainerLabelValue: strings.TrimSpace(cfg.ContainerLabelValue),
			ContainerWorkDir:    strings.TrimSpace(cfg.ContainerWorkDir),
			ContainerUser:       strings.TrimSpace(cfg.ContainerUser),
			CallbackToken:       strings.TrimSpace(cfg.CallbackToken),
			ProjectID:           strings.TrimSpace(cfg.ProjectID),
			ChatSessionID:       strings.TrimSpace(cfg.ChatSessionID),
			TaskID:              strings.TrimSpace(cfg.TaskID),
			Lightweight:         cfg.IsStandaloneMode(),
			PTY:                 ptyManager,
		}
		meta, err := s.store.GetWorkspaceMetadata(cfg.WorkspaceID)
		if err != nil {
			return fmt.Errorf("read initial workspace eviction state: %w", err)
		}
		if meta != nil {
			s.workspaces[cfg.WorkspaceID].EvictionGeneration = meta.EvictionGeneration
			s.workspaces[cfg.WorkspaceID].ProjectID = firstNonEmpty(meta.ProjectID, cfg.ProjectID)
			s.workspaces[cfg.WorkspaceID].ChatSessionID = firstNonEmpty(meta.ChatSessionID, cfg.ChatSessionID)
			if meta.Evicted {
				s.workspaces[cfg.WorkspaceID].Status = "evicted"
			}
		}

	}
	return nil
}

// BootstrapWorkspace serializes legacy bootstrap with explicit lifecycle
// operations. An evicted or already claimed workspace stays dormant until its
// admitted generation starts; successful bootstrap refreshes subsystem tokens.
func (s *Server) BootstrapWorkspace(ctx context.Context, cfg *config.Config, reporter *bootlog.Reporter) error {
	if cfg == nil {
		return fmt.Errorf("workspace bootstrap configuration is required")
	}
	if cfg.WorkspaceID != "" {
		lock := s.workspaceLifecycleLock(cfg.WorkspaceID)
		if err := lock.Lock(ctx); err != nil {
			return err
		}
		defer lock.Unlock()
		runtime, ok := s.getWorkspaceRuntime(cfg.WorkspaceID)
		if !ok {
			slog.Info("Skipping bootstrap for removed workspace", "workspace", cfg.WorkspaceID)
			return nil
		}
		snapshot, err := s.refreshWorkspaceEvictionState(runtime)
		if err != nil {
			return err
		}
		if snapshot.Status != "running" && snapshot.Status != "recovery" || snapshot.ProvisioningActive {
			slog.Info("Skipping bootstrap for inactive or claimed workspace", "workspace", cfg.WorkspaceID, "status", snapshot.Status)
			return nil
		}
	}
	if err := bootstrap.Run(ctx, cfg, reporter); err != nil {
		return err
	}
	s.UpdateAfterBootstrap(cfg)
	return nil
}
