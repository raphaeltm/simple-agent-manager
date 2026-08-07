package server

import (
	"context"
	"fmt"
	"runtime"
	"sort"
	"time"

	"github.com/workspace/vm-agent/internal/errorreport"
	"github.com/workspace/vm-agent/internal/sysinfo"
)

func (s *Server) configureIncidentCollectors() {
	if s == nil || s.errorReporter == nil {
		return
	}
	s.errorReporter.SetCollectors(s.incidentCollectors()...)
}

func (s *Server) incidentCollectors() []errorreport.Collector {
	return []errorreport.Collector{
		errorreport.CollectorFunc{
			CollectorName: "agent-version",
			CollectFunc: func(ctx context.Context, _ errorreport.IncidentContext) (any, error) {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				return map[string]any{
					"version":          sysinfo.Version,
					"buildDate":        sysinfo.BuildDate,
					"buildGoVersion":   sysinfo.GoVersionBuild,
					"runtimeGoVersion": runtime.Version(),
				}, nil
			},
		},
		errorreport.CollectorFunc{
			CollectorName: "system-resources",
			CollectFunc: func(ctx context.Context, _ errorreport.IncidentContext) (any, error) {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				if s.sysInfoCollector == nil {
					return nil, fmt.Errorf("system resource collector is unavailable")
				}
				value, err := s.sysInfoCollector.CollectQuick()
				if ctxErr := ctx.Err(); ctxErr != nil {
					return nil, ctxErr
				}
				return value, err
			},
		},
		errorreport.CollectorFunc{
			CollectorName: "structured-events",
			CollectFunc: func(ctx context.Context, incident errorreport.IncidentContext) (any, error) {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				if s.eventStore == nil {
					return nil, fmt.Errorf("structured event store is unavailable")
				}
				limit := s.config.ErrorReportEventLimit
				if limit < 1 {
					return nil, fmt.Errorf("error report event limit must be positive")
				}
				var events []eventSafePreview
				if incident.WorkspaceID != "" {
					stored, err := s.eventStore.ListWorkspace(incident.WorkspaceID, limit)
					if err != nil {
						return nil, err
					}
					for _, event := range stored {
						events = append(events, eventSafePreview{
							ID: event.ID, Level: event.Level, Type: event.Type,
							WorkspaceID: event.WorkspaceID, CreatedAt: event.CreatedAt,
						})
					}
				} else {
					stored, err := s.eventStore.ListNode(limit)
					if err != nil {
						return nil, err
					}
					for _, event := range stored {
						events = append(events, eventSafePreview{
							ID: event.ID, Level: event.Level, Type: event.Type,
							WorkspaceID: event.WorkspaceID, CreatedAt: event.CreatedAt,
						})
					}
				}
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				return map[string]any{"events": events, "limit": limit}, nil
			},
		},
		errorreport.CollectorFunc{
			CollectorName: "workspace-lifecycle",
			CollectFunc: func(ctx context.Context, _ errorreport.IncidentContext) (any, error) {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				s.workspaceMu.RLock()
				defer s.workspaceMu.RUnlock()
				workspaceIDs := make([]string, 0, len(s.workspaces))
				for workspaceID := range s.workspaces {
					workspaceIDs = append(workspaceIDs, workspaceID)
				}
				sort.Strings(workspaceIDs)
				limit := s.config.ErrorReportEventLimit
				if limit < 1 {
					return nil, fmt.Errorf("error report event limit must be positive")
				}
				if len(workspaceIDs) > limit {
					workspaceIDs = workspaceIDs[:limit]
				}
				workspaces := make([]workspaceSafePreview, 0, len(workspaceIDs))
				for _, workspaceID := range workspaceIDs {
					workspace := s.workspaces[workspaceID]
					workspaces = append(workspaces, workspaceSafePreview{
						ID: workspace.ID, Status: workspace.Status,
						CreatedAt:          workspace.CreatedAt.UTC().Format(time.RFC3339Nano),
						UpdatedAt:          workspace.UpdatedAt.UTC().Format(time.RFC3339Nano),
						Lightweight:        workspace.Lightweight,
						ProvisioningActive: workspace.ProvisioningActive,
					})
				}
				return map[string]any{"workspaces": workspaces, "limit": limit}, nil
			},
		},
	}
}

type eventSafePreview struct {
	ID          string `json:"id"`
	Level       string `json:"level"`
	Type        string `json:"type"`
	WorkspaceID string `json:"workspaceId,omitempty"`
	CreatedAt   string `json:"createdAt"`
}

type workspaceSafePreview struct {
	ID                 string `json:"id"`
	Status             string `json:"status"`
	CreatedAt          string `json:"createdAt"`
	UpdatedAt          string `json:"updatedAt"`
	Lightweight        bool   `json:"lightweight"`
	ProvisioningActive bool   `json:"provisioningActive"`
}
