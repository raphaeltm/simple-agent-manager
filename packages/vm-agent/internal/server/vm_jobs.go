package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"github.com/workspace/vm-agent/internal/deploy"
	"github.com/workspace/vm-agent/internal/persistence"
	"github.com/workspace/vm-agent/internal/publish"
)

const (
	vmJobKindApply       = "deployment-apply"
	vmJobKindRouteConfig = "deployment-route-config"
	vmJobKindPublish     = "deployment-publish"

	vmJobStatusStarting  = "starting"
	vmJobStatusRunning   = "running"
	vmJobStatusSucceeded = "succeeded"
	vmJobStatusFailed    = "failed"
)

func applyJobID(environmentID string, seq int64) string {
	return fmt.Sprintf("apply:%s:%d", environmentID, seq)
}

func routeConfigJobID(environmentID string, revision int64) string {
	return fmt.Sprintf("routes:%s:%d", environmentID, revision)
}

func (s *Server) persistVMJobStart(jobID, kind, scopeID, status, step string) {
	if s == nil || s.store == nil {
		return
	}
	if err := s.store.UpsertJob(persistence.JobRecord{
		ID:          jobID,
		Kind:        kind,
		ScopeID:     scopeID,
		Status:      status,
		CurrentStep: step,
	}); err != nil {
		slog.Warn("vm job: persist start failed", "jobId", jobID, "kind", kind, "error", err)
	}
}

func (s *Server) persistVMJobComplete(jobID, status, step, errorMessage string, result any) {
	if s == nil || s.store == nil {
		return
	}
	resultJSON := ""
	if result != nil {
		if raw, err := json.Marshal(result); err == nil {
			resultJSON = string(raw)
		}
	}
	if err := s.store.CompleteJob(jobID, status, step, errorMessage, resultJSON); err != nil {
		slog.Warn("vm job: persist completion failed", "jobId", jobID, "status", status, "error", err)
	}
}

func (s *Server) persistApplyProgress(_ context.Context, event deploy.ApplyProgressEvent) {
	if s == nil || strings.TrimSpace(event.EnvironmentID) == "" {
		return
	}
	jobID := applyJobID(event.EnvironmentID, event.Seq)
	s.signalApplyProgress(jobID)
	if s.store == nil {
		return
	}
	s.persistVMJobStart(jobID, vmJobKindApply, event.EnvironmentID, vmJobStatusRunning, event.Step)
	if err := s.store.AddJobEvent(jobID, persistence.JobEventRecord{
		Level:       event.Level,
		EventType:   event.EventType,
		CurrentStep: event.Step,
		Message:     event.Message,
		DetailJSON:  marshalJobDetail(event.Detail),
	}); err != nil {
		slog.Warn("vm job: persist apply event failed", "jobId", jobID, "eventType", event.EventType, "error", err)
	}
}

func (s *Server) registerApplyWatchdog(jobID string) func() {
	if s == nil {
		return func() {}
	}
	progress := make(chan struct{}, 1)
	s.applyWatchdogMu.Lock()
	s.applyWatchdogs[jobID] = progress
	s.applyWatchdogMu.Unlock()
	return func() {
		s.applyWatchdogMu.Lock()
		delete(s.applyWatchdogs, jobID)
		s.applyWatchdogMu.Unlock()
	}
}

func (s *Server) signalApplyProgress(jobID string) {
	if s == nil {
		return
	}
	s.applyWatchdogMu.Lock()
	progress := s.applyWatchdogs[jobID]
	s.applyWatchdogMu.Unlock()
	if progress == nil {
		return
	}
	select {
	case progress <- struct{}{}:
	default:
	}
}

func (s *Server) applyProgressChannel(jobID string) <-chan struct{} {
	if s == nil {
		return nil
	}
	s.applyWatchdogMu.Lock()
	defer s.applyWatchdogMu.Unlock()
	return s.applyWatchdogs[jobID]
}

func (s *Server) persistPublishEvent(jobID string, event publish.Event) {
	if s == nil || s.store == nil || strings.TrimSpace(jobID) == "" {
		return
	}
	if err := s.store.AddJobEvent(jobID, persistence.JobEventRecord{
		Level:        event.Level,
		EventType:    event.EventType,
		CurrentStep:  event.CurrentStep,
		Message:      event.Message,
		ErrorMessage: event.ErrorMessage,
		DetailJSON:   marshalJobDetail(event.Detail),
	}); err != nil {
		slog.Warn("vm job: persist publish event failed", "jobId", jobID, "eventType", event.EventType, "error", err)
	}
}

func marshalJobDetail(detail map[string]any) string {
	if len(detail) == 0 {
		return ""
	}
	raw, err := json.Marshal(detail)
	if err != nil {
		return ""
	}
	return string(raw)
}
