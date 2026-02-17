package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type WorktreeInfo struct {
	Path           string `json:"path"`
	Branch         string `json:"branch"`
	HeadCommit     string `json:"headCommit"`
	IsPrimary      bool   `json:"isPrimary"`
	IsDirty        bool   `json:"isDirty"`
	DirtyFileCount int    `json:"dirtyFileCount"`
	IsPrunable     bool   `json:"isPrunable,omitempty"`
}

type createWorktreeRequest struct {
	Branch       string `json:"branch"`
	CreateBranch bool   `json:"createBranch"`
	BaseBranch   string `json:"baseBranch"`
}

func parseWorktreeList(output, primaryPath string) []WorktreeInfo {
	lines := strings.Split(output, "\n")
	worktrees := make([]WorktreeInfo, 0)

	var current *WorktreeInfo
	flush := func() {
		if current != nil && current.Path != "" {
			current.IsPrimary = current.Path == primaryPath
			if current.Branch == "" && current.HeadCommit != "" {
				current.Branch = current.HeadCommit
			}
			worktrees = append(worktrees, *current)
		}
		current = nil
	}

	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			flush()
			continue
		}
		if strings.HasPrefix(line, "worktree ") {
			flush()
			current = &WorktreeInfo{Path: strings.TrimSpace(strings.TrimPrefix(line, "worktree "))}
			continue
		}
		if current == nil {
			continue
		}
		if strings.HasPrefix(line, "branch ") {
			branchRef := strings.TrimSpace(strings.TrimPrefix(line, "branch "))
			current.Branch = strings.TrimPrefix(branchRef, "refs/heads/")
			continue
		}
		if strings.HasPrefix(line, "HEAD ") {
			head := strings.TrimSpace(strings.TrimPrefix(line, "HEAD "))
			if len(head) > 7 {
				head = head[:7]
			}
			current.HeadCommit = head
			continue
		}
		if strings.HasPrefix(line, "prunable") {
			current.IsPrunable = true
		}
	}
	flush()

	return worktrees
}

func sanitizeBranchToDirectoryName(branch string) string {
	branch = strings.TrimSpace(branch)
	if branch == "" {
		return "worktree"
	}
	var b strings.Builder
	b.Grow(len(branch))
	lastDash := false
	for _, r := range branch {
		valid := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_'
		if valid {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			b.WriteRune('-')
			lastDash = true
		}
	}
	clean := strings.Trim(b.String(), "-_")
	if clean == "" {
		return "worktree"
	}
	return clean
}

func (s *Server) getCachedWorktrees(workspaceID string) ([]WorktreeInfo, bool) {
	s.worktreeCacheMu.RLock()
	entry, ok := s.worktreeCache[workspaceID]
	s.worktreeCacheMu.RUnlock()
	if !ok || time.Now().After(entry.expiresAt) {
		return nil, false
	}
	return entry.worktrees, true
}

func (s *Server) setCachedWorktrees(workspaceID string, worktrees []WorktreeInfo) {
	s.worktreeCacheMu.Lock()
	s.worktreeCache[workspaceID] = cachedWorktreeList{
		worktrees: worktrees,
		expiresAt: time.Now().Add(s.config.WorktreeCacheTTL),
	}
	s.worktreeCacheMu.Unlock()
}

func (s *Server) invalidateWorktreeCache(workspaceID string) {
	s.worktreeCacheMu.Lock()
	delete(s.worktreeCache, workspaceID)
	s.worktreeCacheMu.Unlock()
}

func (s *Server) listWorktrees(ctx context.Context, workspaceID, containerID, user, primaryWorkDir string, bypassCache bool) ([]WorktreeInfo, error) {
	if !bypassCache {
		if cached, ok := s.getCachedWorktrees(workspaceID); ok {
			return cached, nil
		}
	}

	stdout, _, err := s.execInContainer(ctx, containerID, user, primaryWorkDir, "git", "worktree", "list", "--porcelain")
	if err != nil {
		return nil, fmt.Errorf("git worktree list failed: %w", err)
	}

	worktrees := parseWorktreeList(stdout, primaryWorkDir)
	for i := range worktrees {
		wt := &worktrees[i]
		if wt.IsPrunable {
			continue
		}
		statusOut, _, statusErr := s.execInContainer(ctx, containerID, user, primaryWorkDir, "git", "-C", wt.Path, "status", "--porcelain")
		if statusErr != nil {
			continue
		}
		trimmed := strings.TrimSpace(statusOut)
		if trimmed == "" {
			continue
		}
		wt.IsDirty = true
		wt.DirtyFileCount = len(strings.Split(trimmed, "\n"))
	}

	s.setCachedWorktrees(workspaceID, worktrees)
	return worktrees, nil
}

func (s *Server) validateWorktreePath(ctx context.Context, workspaceID, containerID, user, primaryWorkDir, requestedPath string) (*WorktreeInfo, error) {
	requestedPath = strings.TrimSpace(requestedPath)
	if requestedPath == "" {
		return nil, fmt.Errorf("not a valid worktree path")
	}
	if strings.ContainsRune(requestedPath, 0) || strings.Contains(requestedPath, "..") {
		return nil, fmt.Errorf("invalid worktree path")
	}
	if !strings.HasPrefix(requestedPath, "/workspaces/") {
		return nil, fmt.Errorf("invalid worktree path")
	}

	worktrees, err := s.listWorktrees(ctx, workspaceID, containerID, user, primaryWorkDir, false)
	if err != nil {
		return nil, err
	}
	for _, wt := range worktrees {
		if wt.Path == requestedPath {
			copy := wt
			return &copy, nil
		}
	}
	return nil, fmt.Errorf("not a valid worktree path")
}

func (s *Server) resolveWorktreeWorkDir(r *http.Request, workspaceID, containerID, user, defaultWorkDir string) (string, error) {
	requested := strings.TrimSpace(r.URL.Query().Get("worktree"))
	return s.resolveExplicitWorktreeWorkDir(r.Context(), workspaceID, containerID, user, defaultWorkDir, requested)
}

func (s *Server) resolveExplicitWorktreeWorkDir(ctx context.Context, workspaceID, containerID, user, defaultWorkDir, requested string) (string, error) {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		return defaultWorkDir, nil
	}
	validateCtx, cancel := context.WithTimeout(ctx, s.config.GitExecTimeout)
	defer cancel()
	wt, err := s.validateWorktreePath(validateCtx, workspaceID, containerID, user, defaultWorkDir, requested)
	if err != nil {
		return "", err
	}
	return wt.Path, nil
}

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

	ctx, cancel := context.WithTimeout(r.Context(), s.config.GitExecTimeout)
	defer cancel()
	worktrees, err := s.listWorktrees(ctx, workspaceID, containerID, user, workDir, false)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"worktrees": worktrees})
}

func (s *Server) handleCreateWorktree(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}
	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	var req createWorktreeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Branch = strings.TrimSpace(req.Branch)
	if req.Branch == "" {
		writeError(w, http.StatusBadRequest, "branch is required")
		return
	}

	containerID, workDir, user, err := s.resolveContainerForWorkspace(workspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.config.GitWorktreeTimeout)
	defer cancel()

	if _, _, err := s.execInContainer(ctx, containerID, user, workDir, "git", "check-ref-format", "--branch", req.Branch); err != nil {
		writeError(w, http.StatusBadRequest, "invalid branch name")
		return
	}

	worktrees, err := s.listWorktrees(ctx, workspaceID, containerID, user, workDir, true)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if len(worktrees) >= s.config.MaxWorktreesPerWorkspace {
		writeError(w, http.StatusUnprocessableEntity, fmt.Sprintf("maximum of %d worktrees per workspace reached", s.config.MaxWorktreesPerWorkspace))
		return
	}
	for _, wt := range worktrees {
		if wt.Branch == req.Branch {
			writeError(w, http.StatusConflict, fmt.Sprintf("branch '%s' is already checked out in worktree at %s", req.Branch, wt.Path))
			return
		}
	}

	repoDirName := filepath.Base(workDir)
	targetPath := filepath.Join("/workspaces", fmt.Sprintf("%s-wt-%s", repoDirName, sanitizeBranchToDirectoryName(req.Branch)))

	if req.CreateBranch {
		base := strings.TrimSpace(req.BaseBranch)
		if base == "" {
			base = "HEAD"
		}
		if _, _, err := s.execInContainer(ctx, containerID, user, workDir, "git", "worktree", "add", "-b", req.Branch, targetPath, base); err != nil {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("failed to create worktree: %v", err))
			return
		}
	} else {
		if _, _, err := s.execInContainer(ctx, containerID, user, workDir, "git", "rev-parse", "--verify", req.Branch); err != nil {
			writeError(w, http.StatusNotFound, fmt.Sprintf("branch '%s' does not exist", req.Branch))
			return
		}
		if _, _, err := s.execInContainer(ctx, containerID, user, workDir, "git", "worktree", "add", targetPath, req.Branch); err != nil {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("failed to create worktree: %v", err))
			return
		}
	}

	s.invalidateWorktreeCache(workspaceID)
	refreshed, err := s.listWorktrees(ctx, workspaceID, containerID, user, workDir, true)
	if err != nil {
		writeError(w, http.StatusCreated, "worktree created")
		return
	}
	for _, wt := range refreshed {
		if wt.Path == targetPath {
			writeJSON(w, http.StatusCreated, wt)
			return
		}
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"path":           targetPath,
		"branch":         req.Branch,
		"headCommit":     "",
		"isPrimary":      false,
		"isDirty":        false,
		"dirtyFileCount": 0,
	})
}

func (s *Server) stopAgentSessionsBoundToWorktree(workspaceID, worktreePath string) {
	type stopTarget struct {
		hostKey   string
		sessionID string
	}
	targets := make([]stopTarget, 0)

	s.sessionHostMu.Lock()
	for hostKey, host := range s.sessionHosts {
		if !strings.HasPrefix(hostKey, workspaceID+":") {
			continue
		}
		if host == nil || host.ContainerWorkDir() != worktreePath {
			continue
		}
		sessionID := strings.TrimPrefix(hostKey, workspaceID+":")
		targets = append(targets, stopTarget{hostKey: hostKey, sessionID: sessionID})
	}
	for _, target := range targets {
		if host := s.sessionHosts[target.hostKey]; host != nil {
			host.Stop()
		}
		delete(s.sessionHosts, target.hostKey)
	}
	s.sessionHostMu.Unlock()

	for _, target := range targets {
		if s.agentSessions != nil {
			_, _ = s.agentSessions.Stop(workspaceID, target.sessionID)
		}
		if s.store != nil {
			_ = s.store.DeleteTab(target.sessionID)
		}
	}
}

func (s *Server) handleRemoveWorktree(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}
	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	removePath := strings.TrimSpace(r.URL.Query().Get("path"))
	if removePath == "" {
		writeError(w, http.StatusBadRequest, "path query parameter is required")
		return
	}
	force, _ := strconv.ParseBool(strings.TrimSpace(r.URL.Query().Get("force")))

	containerID, workDir, user, err := s.resolveContainerForWorkspace(workspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.config.GitWorktreeTimeout)
	defer cancel()
	wt, err := s.validateWorktreePath(ctx, workspaceID, containerID, user, workDir, removePath)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if wt.IsPrimary {
		writeError(w, http.StatusBadRequest, "cannot remove the primary worktree")
		return
	}
	if wt.IsDirty && !force {
		writeJSON(w, http.StatusConflict, map[string]interface{}{
			"error":          "WORKTREE_DIRTY",
			"message":        "Worktree has uncommitted changes",
			"dirtyFileCount": wt.DirtyFileCount,
		})
		return
	}

	s.stopAgentSessionsBoundToWorktree(workspaceID, wt.Path)

	args := []string{"git", "worktree", "remove"}
	if force {
		args = append(args, "--force")
	}
	args = append(args, wt.Path)
	if _, _, err := s.execInContainer(ctx, containerID, user, workDir, args...); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("failed to remove worktree: %v", err))
		return
	}

	s.invalidateWorktreeCache(workspaceID)
	writeJSON(w, http.StatusOK, map[string]interface{}{"removed": wt.Path})
}
