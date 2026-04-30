package server

import (
	"context"
	"fmt"
	"log/slog"
)

type workspaceProvisionRequest struct {
	runtime        *WorkspaceRuntime
	failureType    string
	failureMessage string
	successType    string
	successMessage string
	detail         map[string]interface{}
}

// BlockWorkspaceProvisioning prevents dynamic workspace provisioning from
// starting while system provisioning is still mutating Docker.
func (s *Server) BlockWorkspaceProvisioning() {
	s.provisionGateMu.Lock()
	defer s.provisionGateMu.Unlock()

	s.provisionReady = false
	s.provisionErr = nil
}

// CompleteWorkspaceProvisioning opens the provisioning gate and starts any
// workspace requests that arrived while system provisioning was running.
func (s *Server) CompleteWorkspaceProvisioning() {
	s.provisionGateMu.Lock()
	s.provisionReady = true
	s.provisionErr = nil
	queued := append([]workspaceProvisionRequest(nil), s.provisionQueue...)
	s.provisionQueue = nil
	s.provisionGateMu.Unlock()

	for _, req := range queued {
		if req.runtime != nil {
			slog.Info("Starting queued workspace provisioning", "workspace", req.runtime.ID)
		}
		s.startWorkspaceProvisionNow(req)
	}
}

// FailWorkspaceProvisioning fails queued workspace requests when system
// provisioning cannot reach a workspace-safe state.
func (s *Server) FailWorkspaceProvisioning(err error) {
	if err == nil {
		err = fmt.Errorf("system provisioning failed")
	}

	s.provisionGateMu.Lock()
	s.provisionReady = false
	s.provisionErr = err
	queued := append([]workspaceProvisionRequest(nil), s.provisionQueue...)
	s.provisionQueue = nil
	s.provisionGateMu.Unlock()

	for _, req := range queued {
		s.failQueuedWorkspaceProvision(req, err)
	}
}

func (s *Server) enqueueOrStartWorkspaceProvision(req workspaceProvisionRequest) bool {
	s.provisionGateMu.Lock()

	if s.provisionReady {
		s.provisionGateMu.Unlock()
		return true
	}

	if s.provisionErr != nil {
		err := s.provisionErr
		s.provisionGateMu.Unlock()
		go s.failQueuedWorkspaceProvision(req, err)
		return false
	}

	s.provisionQueue = append(s.provisionQueue, req)
	queueDepth := len(s.provisionQueue)
	s.provisionGateMu.Unlock()

	if req.runtime != nil {
		detail := copyEventDetail(req.detail)
		detail["workspaceId"] = req.runtime.ID
		detail["queueDepth"] = queueDepth
		detail["reason"] = "system_provisioning_in_progress"
		s.appendNodeEvent(req.runtime.ID, "info", "workspace.queued", "Workspace provisioning queued until node provisioning completes", detail)
		slog.Info("Workspace provisioning queued until system provisioning completes",
			"workspace", req.runtime.ID,
			"queueDepth", queueDepth)
	}

	return false
}

func (s *Server) failQueuedWorkspaceProvision(req workspaceProvisionRequest, err error) {
	if req.runtime == nil {
		return
	}

	if s.bootLogBroadcasters != nil {
		if broadcaster := s.bootLogBroadcasters.Get(req.runtime.ID); broadcaster != nil {
			broadcaster.MarkComplete()
		}
	}

	errorMsg := fmt.Sprintf("node system provisioning failed before workspace provisioning could start: %v", err)
	s.casWorkspaceStatus(req.runtime.ID, []string{"creating"}, "error")

	callbackToken := s.callbackTokenForWorkspace(req.runtime.ID)
	if callbackToken != "" {
		if callbackErr := s.notifyWorkspaceProvisioningFailed(context.Background(), req.runtime.ID, callbackToken, errorMsg); callbackErr != nil {
			slog.Error("Provisioning-failed callback error", "workspace", req.runtime.ID, "error", callbackErr)
		}
	}

	failureDetail := copyEventDetail(req.detail)
	failureDetail["workspaceId"] = req.runtime.ID
	failureDetail["error"] = errorMsg
	failureDetail["queued"] = true
	s.appendNodeEvent(req.runtime.ID, "error", req.failureType, req.failureMessage, failureDetail)
}

func copyEventDetail(detail map[string]interface{}) map[string]interface{} {
	cp := make(map[string]interface{}, len(detail)+4)
	for key, value := range detail {
		cp[key] = value
	}
	return cp
}
