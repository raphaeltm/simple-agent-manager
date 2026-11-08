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
	// CallbackToken is the workspace callback token the control plane minted
	// when it rotated the workspace's callback generation for this restart or
	// rebuild. The previous generation's tokens are already revoked, so a
	// delivered token replaces the current one unconditionally. Empty means
	// none was delivered (an older control plane): the current token is kept.
	// Agents predating the field reject it as unknown with 400, which the
	// control plane treats as "this agent cannot rotate".
	CallbackToken string `json:"callbackToken,omitempty"`
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

// validateReprovisionCallbackToken rejects a delivered token that is not this
// workspace's callback token, before the restart changes any state. The request
// itself is authenticated with a node-management JWT and the control plane
// verifies every token it later receives, so only the claims are checked.
func validateReprovisionCallbackToken(workspaceID, token string) error {
	if token == "" {
		return nil
	}
	if _, ok := decodeCallbackTokenClaims(strings.TrimSpace(token)); !ok {
		return errors.New("workspace restart callbackToken is not a callback token")
	}
	if callbackTokenNamesOtherWorkspace(strings.TrimSpace(token), workspaceID) {
		return errors.New("workspace restart callbackToken is not this workspace's token")
	}
	return nil
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
	snapshot, statusCode, err := s.commitWorkspaceReprovision(runtime, previous, body, statusCode, persistErr)
	if err != nil {
		return nil, WorkspaceRuntime{}, statusCode, err
	}
	if body.CallbackToken != "" {
		// The new token is installed and persisted; hand it to the consumers that
		// copied the old one. propagateWorkspaceCallbackToken must run without
		// workspaceMu, and before the caller starts provisioning from snapshot.
		s.setWorkspaceTokenRenewalState(workspaceID, workspaceTokenRenewalState{})
		s.propagateWorkspaceCallbackToken(workspaceID, snapshot.CallbackToken)
	}
	return runtime, snapshot, 0, nil
}

// commitWorkspaceReprovision applies a claimed restart in memory, in the final
// workspaceMu critical section, and returns the snapshot provisioning starts from.
func (s *Server) commitWorkspaceReprovision(runtime *WorkspaceRuntime, previous WorkspaceRuntime, body workspaceReprovisionRequest, statusCode int, persistErr error) (WorkspaceRuntime, int, error) {
	s.workspaceMu.Lock()
	defer s.workspaceMu.Unlock()
	if persistErr != nil {
		runtime.ProvisioningActive = previous.ProvisioningActive
		return WorkspaceRuntime{}, statusCode, persistErr
	}
	if body.EvictionGeneration != "" {
		runtime.EvictionGeneration = body.EvictionGeneration
	}
	if body.CallbackToken != "" {
		// Authoritative replace, NOT adoptWorkspaceCallbackTokenLocked's
		// "later expiry wins" rule: the control plane revoked the old token's
		// generation before sending this one, so keeping the old token because it
		// expires later would keep a credential that no longer works.
		runtime.CallbackToken = strings.TrimSpace(body.CallbackToken)
	}
	s.resetResourceHistoryAfterReprovision(runtime.ID)
	runtime.Status = "creating"
	runtime.UpdatedAt = nowUTC()
	if body.CallbackToken != "" && s.store != nil {
		// persistWorkspaceReprovision wrote the pre-restart snapshot, which holds
		// the revoked token. Persist the new one before any consumer sees it so
		// an agent restart resumes with the working credential. The upsert leaves
		// eviction_generation and evicted alone (only the restart CAS moves them).
		if err := s.writeWorkspaceMetadata(runtime); err != nil {
			slog.Error("Failed to persist delivered workspace callback token", "workspace", runtime.ID, "error", err)
		}
	}
	return *runtime, 0, nil
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
	if err := validateReprovisionCallbackToken(workspaceID, body.CallbackToken); err != nil {
		return nil, WorkspaceRuntime{}, http.StatusBadRequest, err
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
