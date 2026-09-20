package server

import (
	"context"
	"log/slog"
	"path/filepath"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/container"
	"github.com/workspace/vm-agent/internal/resourcehistory"
)

type resourceHistoryObserver struct {
	server      *Server
	workspaceID string
}

func (o resourceHistoryObserver) RecordACPToolCall(toolCallID string, status string, at time.Time) {
	if o.server == nil {
		return
	}
	if collector := o.server.resourceHistoryCollector(o.workspaceID); collector != nil {
		collector.RecordACPToolCall(toolCallID, status, at)
	}
}

func (o resourceHistoryObserver) ReconcileACPToolCalls(at time.Time) {
	if o.server == nil {
		return
	}
	if collector := o.server.resourceHistoryCollector(o.workspaceID); collector != nil {
		collector.ReconcileACPToolCalls(at)
	}
}

func (s *Server) resourceHistoryObserverForWorkspace(workspaceID string) resourceHistoryObserver {
	return resourceHistoryObserver{server: s, workspaceID: strings.TrimSpace(workspaceID)}
}

func (s *Server) resourceHistoryCollector(workspaceID string) *resourcehistory.Collector {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return nil
	}
	s.resourceHistoryMu.Lock()
	defer s.resourceHistoryMu.Unlock()
	return s.resourceHistories[workspaceID]
}

func (s *Server) ensureResourceHistoryForRuntime(runtime *WorkspaceRuntime) {
	if s == nil || s.config == nil || runtime == nil {
		return
	}
	if s.config.Role != config.RoleWorkspace {
		return
	}
	workspaceID := strings.TrimSpace(runtime.ID)
	projectID := strings.TrimSpace(runtime.ProjectID)
	if workspaceID == "" || projectID == "" || strings.TrimSpace(s.config.ControlPlaneURL) == "" {
		return
	}
	metadata := resourcehistory.Attribution{
		ProjectID: projectID,
		SessionID: strings.TrimSpace(runtime.ChatSessionID),
		TaskID:    strings.TrimSpace(runtime.TaskID),
		Runtime:   "vm",
		AgentType: "",
		SkillID:   "",
		ProfileID: "",
	}

	s.resourceHistoryMu.Lock()
	if s.resourceHistories == nil {
		s.resourceHistories = make(map[string]*resourcehistory.Collector)
	}
	if existing := s.resourceHistories[workspaceID]; existing != nil {
		existing.UpdateAttribution(metadata)
		started := s.resourceHistoryStarted.Load()
		s.resourceHistoryMu.Unlock()
		if started {
			existing.Start(context.Background())
		}
		return
	}
	collector := resourcehistory.New(resourcehistory.Config{
		ControlPlaneURL: s.config.ControlPlaneURL,
		ProjectID:       projectID,
		WorkspaceID:     workspaceID,
		NodeID:          s.config.NodeID,
		SessionID:       metadata.SessionID,
		TaskID:          metadata.TaskID,
		AgentType:       metadata.AgentType,
		Runtime:         metadata.Runtime,
		SampleInterval:  s.config.ResourceHistorySampleInterval,
		ChunkInterval:   s.config.ResourceHistoryChunkInterval,
		UploadTimeout:   s.config.ResourceHistoryUploadTimeout,
		SpoolDir:        filepath.Join(s.config.ResourceHistorySpoolDir, sanitizeWorkspaceRuntimeID(workspaceID)),
		SpoolMaxBytes:   s.config.ResourceHistorySpoolMaxBytes,
		MaxSamples:      s.config.ResourceHistoryMaxSamples,
		ContainerID:     s.resourceHistoryContainerResolver(runtime.ContainerLabelValue),
		CallbackToken: func() string {
			return s.callbackTokenForWorkspace(workspaceID)
		},
		HTTPClient: config.NewControlPlaneClient(s.config.HTTPCallbackTimeout),
		Logger:     slog.Default(),
	})
	s.resourceHistories[workspaceID] = collector
	started := s.resourceHistoryStarted.Load()
	s.resourceHistoryMu.Unlock()
	if started {
		collector.Start(context.Background())
	}
}

func (s *Server) resourceHistoryContainerResolver(labelValue string) func(context.Context) (string, error) {
	labelValue = strings.TrimSpace(labelValue)
	if s == nil || s.config == nil || !s.config.ContainerMode {
		return nil
	}
	if labelValue == "" {
		labelValue = strings.TrimSpace(s.config.ContainerLabelValue)
	}
	discovery := container.NewDiscovery(container.Config{
		LabelKey:   s.config.ContainerLabelKey,
		LabelValue: labelValue,
		CacheTTL:   s.config.ContainerCacheTTL,
	})
	return func(ctx context.Context) (string, error) {
		return discovery.GetContainerIDContext(ctx)
	}
}

func (s *Server) updateResourceHistoryAttribution(workspaceID, projectID, sessionID, taskID string) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return
	}
	var snapshot *WorkspaceRuntime
	s.workspaceMu.Lock()
	if rt, ok := s.workspaces[workspaceID]; ok {
		if strings.TrimSpace(projectID) != "" {
			rt.ProjectID = strings.TrimSpace(projectID)
		}
		if strings.TrimSpace(sessionID) != "" {
			rt.ChatSessionID = strings.TrimSpace(sessionID)
		}
		if strings.TrimSpace(taskID) != "" {
			rt.TaskID = strings.TrimSpace(taskID)
		}
		runtimeCopy := *rt
		snapshot = &runtimeCopy
	}
	s.workspaceMu.Unlock()
	if snapshot != nil {
		s.ensureResourceHistoryForRuntime(snapshot)
	}
}

func (s *Server) stopResourceHistoryForWorkspace(workspaceID string, ctx context.Context) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return
	}
	s.resourceHistoryMu.Lock()
	collector := s.resourceHistories[workspaceID]
	delete(s.resourceHistories, workspaceID)
	s.resourceHistoryMu.Unlock()
	if collector != nil {
		if ctx == nil {
			ctx = context.Background()
		}
		deadline := s.config.ResourceHistoryUploadTimeout
		if deadline <= 0 {
			deadline = 10 * time.Second
		}
		stopCtx, cancel := context.WithTimeout(ctx, deadline)
		defer cancel()
		collector.Stop(stopCtx)
	}
}

func (s *Server) startAllResourceHistoryCollectors() {
	s.workspaceMu.RLock()
	runtimes := make([]*WorkspaceRuntime, 0, len(s.workspaces))
	for _, rt := range s.workspaces {
		runtimeCopy := *rt
		runtimes = append(runtimes, &runtimeCopy)
	}
	s.workspaceMu.RUnlock()
	for _, rt := range runtimes {
		s.ensureResourceHistoryForRuntime(rt)
	}
}

func (s *Server) stopAllResourceHistoryCollectors(ctx context.Context) {
	s.resourceHistoryMu.Lock()
	collectors := s.resourceHistories
	s.resourceHistories = make(map[string]*resourcehistory.Collector)
	s.resourceHistoryMu.Unlock()
	for workspaceID, collector := range collectors {
		if collector != nil {
			collector.Stop(ctx)
			slog.Info("Resource history collector stopped", "workspace", workspaceID)
		}
	}
}
