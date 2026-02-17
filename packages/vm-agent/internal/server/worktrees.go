package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"strings"
)

// WorktreeCreateRequest is the request body for creating a worktree.
type WorktreeCreateRequest struct {
	Branch       string `json:"branch"`
	BaseBranch   string `json:"baseBranch,omitempty"`
	CreateBranch bool   `json:"createBranch,omitempty"`
}

// WorktreeListResponseBody is the response body for listing worktrees.
type WorktreeListResponseBody struct {
	Worktrees []WorktreeInfo `json:"worktrees"`
}

// WorktreeCreateResponseBody is the response body for creating a worktree.
type WorktreeCreateResponseBody struct {
	Worktree WorktreeInfo `json:"worktree"`
}

// WorktreeRemoveResponseBody is the response body for removing a worktree.
type WorktreeRemoveResponseBody struct {
	Removed         string   `json:"removed"`
	StoppedSessions []string `json:"stoppedSessions"`
}

// handleListWorktrees handles GET /workspaces/{workspaceId}/worktrees
func (s *Server) handleListWorktrees(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	containerID, workDir, user, err := s.resolveContainerForWorkspace(workspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.config.WorktreeExecTimeout)
	defer cancel()

	worktrees, err := s.worktreeValidator.ListWorktrees(ctx, workspaceID, s.execInContainer, containerID, user, workDir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("failed to list worktrees: %v", err))
		return
	}

	writeJSON(w, http.StatusOK, WorktreeListResponseBody{Worktrees: worktrees})
}

// handleCreateWorktree handles POST /workspaces/{workspaceId}/worktrees
func (s *Server) handleCreateWorktree(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	var req WorktreeCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Branch == "" {
		writeError(w, http.StatusBadRequest, "branch is required")
		return
	}

	containerID, workDir, user, err := s.resolveContainerForWorkspace(workspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.config.WorktreeExecTimeout)
	defer cancel()

	// Check current worktree count against limit
	existing, err := s.worktreeValidator.ListWorktrees(ctx, workspaceID, s.execInContainer, containerID, user, workDir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("failed to list worktrees: %v", err))
		return
	}

	if len(existing) >= s.config.MaxWorktreesPerWorkspace {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":   "MAX_WORKTREES_EXCEEDED",
			"message": fmt.Sprintf("workspace already has %d worktrees (max: %d)", len(existing), s.config.MaxWorktreesPerWorkspace),
		})
		return
	}

	// Derive the worktree directory name
	repoDirName := filepath.Base(workDir)
	worktreeDirName := SanitizeWorktreeDirName(repoDirName, req.Branch)
	worktreePath := filepath.Join("/workspaces", worktreeDirName)

	// Build the git worktree add command
	var args []string
	if req.CreateBranch {
		baseBranch := req.BaseBranch
		if baseBranch == "" {
			baseBranch = "HEAD"
		}
		// git worktree add -b <branch> <path> <base>
		args = []string{"git", "worktree", "add", "-b", req.Branch, worktreePath, baseBranch}
	} else {
		// git worktree add <path> <branch>
		args = []string{"git", "worktree", "add", worktreePath, req.Branch}
	}

	stdout, stderr, err := s.execInContainer(ctx, containerID, user, workDir, args...)
	if err != nil {
		errMsg := stderr
		if errMsg == "" {
			errMsg = stdout
		}

		// Classify the error
		if strings.Contains(errMsg, "already checked out") || strings.Contains(errMsg, "is already checked out") {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error":   "BRANCH_ALREADY_CHECKED_OUT",
				"message": fmt.Sprintf("branch '%s' is already checked out in another worktree", req.Branch),
			})
			return
		}
		if strings.Contains(errMsg, "already exists") && req.CreateBranch {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error":   "BRANCH_ALREADY_EXISTS",
				"message": fmt.Sprintf("branch '%s' already exists", req.Branch),
			})
			return
		}
		if strings.Contains(errMsg, "not a valid branch name") || strings.Contains(errMsg, "invalid reference") {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error":   "INVALID_BRANCH_NAME",
				"message": fmt.Sprintf("'%s' is not a valid branch name", req.Branch),
			})
			return
		}

		log.Printf("[worktree] create failed for workspace %s: %v, stderr: %s", workspaceID, err, stderr)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error":   "WORKTREE_CREATE_FAILED",
			"message": fmt.Sprintf("git worktree add failed: %s", errMsg),
		})
		return
	}

	// Invalidate cache so the new worktree is visible
	s.worktreeValidator.InvalidateCache(workspaceID)

	// Fetch the updated list to return the new worktree info
	updatedWorktrees, err := s.worktreeValidator.ListWorktrees(ctx, workspaceID, s.execInContainer, containerID, user, workDir)
	if err != nil {
		// Creation succeeded but we can't return full info — return minimal
		writeJSON(w, http.StatusCreated, WorktreeCreateResponseBody{
			Worktree: WorktreeInfo{
				Path:   worktreePath,
				Branch: req.Branch,
			},
		})
		return
	}

	// Find the newly created worktree
	for _, wt := range updatedWorktrees {
		if wt.Path == worktreePath {
			writeJSON(w, http.StatusCreated, WorktreeCreateResponseBody{Worktree: wt})
			return
		}
	}

	// Fallback — return minimal info
	writeJSON(w, http.StatusCreated, WorktreeCreateResponseBody{
		Worktree: WorktreeInfo{
			Path:   worktreePath,
			Branch: req.Branch,
		},
	})
}

// handleRemoveWorktree handles DELETE /workspaces/{workspaceId}/worktrees?path=...&force=false
func (s *Server) handleRemoveWorktree(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	worktreePath := r.URL.Query().Get("path")
	if worktreePath == "" {
		writeError(w, http.StatusBadRequest, "path query parameter is required")
		return
	}

	force := r.URL.Query().Get("force") == "true"

	containerID, workDir, user, err := s.resolveContainerForWorkspace(workspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.config.WorktreeExecTimeout)
	defer cancel()

	// Validate the path is a real worktree
	wtInfo, err := s.worktreeValidator.ValidateWorktreePath(ctx, workspaceID, worktreePath, s.execInContainer, containerID, user, workDir)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":   "INVALID_WORKTREE_PATH",
			"message": err.Error(),
		})
		return
	}

	// Cannot remove primary worktree
	if wtInfo.IsPrimary {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":   "CANNOT_REMOVE_PRIMARY",
			"message": "the primary worktree cannot be removed",
		})
		return
	}

	// Check dirty state if not forcing
	if wtInfo.IsDirty && !force {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":   "WORKTREE_DIRTY",
			"message": fmt.Sprintf("worktree has %d uncommitted changes; use force=true to remove", wtInfo.DirtyFileCount),
		})
		return
	}

	// Stop any agent sessions bound to this worktree
	stoppedSessions := s.stopSessionsForWorktree(workspaceID, worktreePath)

	// Remove the worktree
	args := []string{"git", "worktree", "remove", worktreePath}
	if force {
		args = []string{"git", "worktree", "remove", "--force", worktreePath}
	}

	_, stderr, err := s.execInContainer(ctx, containerID, user, workDir, args...)
	if err != nil {
		log.Printf("[worktree] remove failed for workspace %s path %s: %v, stderr: %s", workspaceID, worktreePath, err, stderr)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error":   "WORKTREE_REMOVE_FAILED",
			"message": fmt.Sprintf("git worktree remove failed: %s", stderr),
		})
		return
	}

	// Invalidate cache
	s.worktreeValidator.InvalidateCache(workspaceID)

	writeJSON(w, http.StatusOK, WorktreeRemoveResponseBody{
		Removed:         worktreePath,
		StoppedSessions: stoppedSessions,
	})
}

// stopSessionsForWorktree stops all agent sessions bound to a specific worktree path.
// Returns the list of stopped session IDs.
func (s *Server) stopSessionsForWorktree(workspaceID, worktreePath string) []string {
	var stoppedIDs []string

	if s.agentSessions == nil {
		return stoppedIDs
	}

	sessions := s.agentSessions.List(workspaceID)
	for _, session := range sessions {
		if session.WorktreePath == worktreePath {
			if _, err := s.agentSessions.Stop(workspaceID, session.ID); err != nil {
				log.Printf("[worktree] failed to stop session %s for worktree removal: %v", session.ID, err)
				continue
			}
			s.stopSessionHost(workspaceID, session.ID)
			stoppedIDs = append(stoppedIDs, session.ID)
		}
	}

	return stoppedIDs
}

// resolveWorktreeWorkDir resolves the effective working directory for a request.
// If a worktree query parameter is provided and valid, returns the worktree path.
// Otherwise returns the primary workspace work directory.
func (s *Server) resolveWorktreeWorkDir(
	ctx context.Context,
	r *http.Request,
	w http.ResponseWriter,
	workspaceID, containerID, user, primaryWorkDir string,
) (string, bool) {
	worktreeParam := r.URL.Query().Get("worktree")
	if worktreeParam == "" {
		return primaryWorkDir, true
	}

	_, err := s.worktreeValidator.ValidateWorktreePath(
		ctx, workspaceID, worktreeParam,
		s.execInContainer, containerID, user, primaryWorkDir,
	)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":   "INVALID_WORKTREE_PATH",
			"message": err.Error(),
		})
		return "", false
	}

	return worktreeParam, true
}
