package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
)

type workspaceReprovisionRequest struct {
	EvictionGeneration         string  `json:"evictionGeneration"`
	ExpectedEvictionGeneration *string `json:"expectedEvictionGeneration"`
}

func decodeWorkspaceReprovisionRequest(w http.ResponseWriter, r *http.Request) (workspaceReprovisionRequest, bool) {
	var body workspaceReprovisionRequest
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid workspace restart request")
		return body, false
	}
	var trailing interface{}
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid workspace restart request")
		return body, false
	}
	return body, true
}

func validEvictionGeneration(value string) bool {
	// Canonical ULIDs have 26 Crockford base32 characters and fit in 128 bits.
	if len(value) != 26 || value[0] > '7' {
		return false
	}
	for _, ch := range value {
		if !strings.ContainsRune("0123456789ABCDEFGHJKMNPQRSTVWXYZ", ch) {
			return false
		}
	}
	return true
}

func validateWorkspaceReprovisionGeneration(runtime *WorkspaceRuntime, body workspaceReprovisionRequest) (int, error) {
	if body.EvictionGeneration == "" && body.ExpectedEvictionGeneration == nil && runtime.Status != "evicted" && runtime.EvictionGeneration == "" {
		return 0, nil // Compatibility for management clients predating eviction fencing.
	}
	if !validEvictionGeneration(body.EvictionGeneration) || body.ExpectedEvictionGeneration == nil {
		return http.StatusBadRequest, errors.New("workspace restart requires a valid evictionGeneration and expectedEvictionGeneration")
	}
	if *body.ExpectedEvictionGeneration != runtime.EvictionGeneration || body.EvictionGeneration == runtime.EvictionGeneration {
		return http.StatusConflict, errors.New("workspace eviction generation changed")
	}
	return 0, nil
}

// claimWorkspaceReprovision serializes a restart with eviction and recovery for
// this workspace. SQLite I/O runs without the global workspace mutex; the active
// claim prevents ordinary metadata updates from changing the lifecycle state.
func (s *Server) claimWorkspaceReprovision(ctx context.Context, workspaceID string, body workspaceReprovisionRequest, allowedStatuses []string) (*WorkspaceRuntime, WorkspaceRuntime, int, error) {
	lock := s.workspaceLifecycleLock(workspaceID)
	if err := lock.Lock(ctx); err != nil {
		return nil, WorkspaceRuntime{}, http.StatusRequestTimeout, err
	}
	defer lock.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, WorkspaceRuntime{}, http.StatusRequestTimeout, err
	}
	if current, ok := s.getWorkspaceRuntime(workspaceID); ok {
		if _, err := s.refreshWorkspaceEvictionState(current); err != nil {
			return nil, WorkspaceRuntime{}, http.StatusServiceUnavailable, err
		}
	}
	runtime, previous, statusCode, err := s.prepareWorkspaceReprovision(workspaceID, body, allowedStatuses)
	if err != nil {
		return nil, WorkspaceRuntime{}, statusCode, err
	}
	statusCode, persistErr := s.persistWorkspaceReprovision(&previous, body.EvictionGeneration)
	s.workspaceMu.Lock()
	defer s.workspaceMu.Unlock()
	if persistErr != nil {
		runtime.ProvisioningActive = previous.ProvisioningActive
		return nil, WorkspaceRuntime{}, statusCode, persistErr
	}
	if body.EvictionGeneration != "" {
		runtime.EvictionGeneration = body.EvictionGeneration
	}
	runtime.Status = "creating"
	runtime.UpdatedAt = nowUTC()
	return runtime, *runtime, 0, nil
}

func (s *Server) prepareWorkspaceReprovision(workspaceID string, body workspaceReprovisionRequest, allowedStatuses []string) (*WorkspaceRuntime, WorkspaceRuntime, int, error) {
	s.workspaceMu.Lock()
	defer s.workspaceMu.Unlock()
	runtime := s.workspaces[workspaceID]
	if runtime == nil {
		return nil, WorkspaceRuntime{}, http.StatusNotFound, errors.New("workspace not found")
	}
	if runtime.MetadataUnavailable {
		return nil, WorkspaceRuntime{}, http.StatusServiceUnavailable, errWorkspaceMetadataUnavailable
	}
	allowed := false
	for _, status := range allowedStatuses {
		allowed = allowed || runtime.Status == status
	}
	if !allowed || runtime.ProvisioningActive {
		return nil, WorkspaceRuntime{}, http.StatusConflict, errors.New("workspace cannot be restarted from its current state")
	}
	if status, err := validateWorkspaceReprovisionGeneration(runtime, body); err != nil {
		return nil, WorkspaceRuntime{}, status, err
	}
	previous := *runtime
	runtime.ProvisioningActive = true
	return runtime, previous, 0, nil
}

func (s *Server) persistWorkspaceReprovision(previous *WorkspaceRuntime, generation string) (int, error) {
	if generation == "" {
		return 0, nil
	}
	if s.store == nil {
		return http.StatusInternalServerError, errors.New("workspace restart persistence is unavailable")
	}
	if err := s.writeWorkspaceMetadata(previous); err != nil {
		slog.Error("Failed to persist workspace before restart", "workspace", previous.ID, "error", err)
		return http.StatusInternalServerError, errors.New("failed to persist workspace restart")
	}
	changed, err := s.store.CompareAndSwapWorkspaceEvictionGeneration(previous.ID, previous.EvictionGeneration, generation)
	if err != nil {
		slog.Error("Failed to persist workspace restart generation", "workspace", previous.ID, "error", err)
		return http.StatusInternalServerError, errors.New("failed to persist workspace restart")
	}
	if !changed {
		return http.StatusConflict, errors.New("workspace eviction generation changed")
	}
	return 0, nil
}

func writeWorkspaceReprovisionError(w http.ResponseWriter, status int, err error) {
	if status == http.StatusConflict {
		writeJSON(w, status, map[string]interface{}{"error": "invalid_transition", "message": err.Error()})
		return
	}
	writeError(w, status, err.Error())
}

// requireWorkspaceCreateEvictionState runs under the lifecycle lock before
// create can update metadata or start either provisioning implementation.
func (s *Server) requireWorkspaceCreateEvictionState(w http.ResponseWriter, workspaceID string) bool {
	if runtime, ok := s.getWorkspaceRuntime(workspaceID); ok {
		snapshot, err := s.refreshWorkspaceEvictionState(runtime)
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return false
		}
		if snapshot.Status == "evicted" {
			writeError(w, http.StatusConflict, "evicted workspace requires an admitted restart")
			return false
		}
	}
	if s.store != nil {
		meta, err := s.store.GetWorkspaceMetadata(workspaceID)
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, errWorkspaceMetadataUnavailable.Error())
			return false
		}
		if meta != nil && meta.Evicted {
			writeError(w, http.StatusConflict, "evicted workspace requires an admitted restart")
			return false
		}
	}
	return true
}
