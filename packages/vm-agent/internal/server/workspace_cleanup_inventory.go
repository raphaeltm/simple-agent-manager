package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/workspace/vm-agent/internal/config"
)

// This bounded inventory is diagnostic only. Unknown directories, including
// legacy/user roots without ownership proof, never gain deletion authority.
func (s *Server) inventoryWorkspaceCleanup(ctx context.Context) {
	if s.store == nil || ctx.Err() != nil {
		return
	}
	limit := s.config.WorkspaceDeletionBatchSize
	if limit <= 0 {
		limit = config.DefaultWorkspaceDeletionBatchSize
	}
	dir, err := os.Open(s.config.WorkspaceDir)
	if err != nil {
		return
	}
	defer dir.Close()
	entries, err := dir.ReadDir(limit + 1)
	if err != nil && len(entries) == 0 {
		return
	}
	truncated := len(entries) > limit
	if truncated {
		entries = entries[:limit]
	}
	known, pending, unknown := 0, 0, 0
	for _, entry := range entries {
		if ctx.Err() != nil {
			return
		}
		if !entry.IsDir() {
			continue
		}
		id := entry.Name()
		intent, err := s.store.GetWorkspaceDeletion(id)
		if err != nil {
			return
		}
		if intent != "" {
			pending++
			continue
		}
		meta, err := s.store.GetWorkspaceMetadata(id)
		if err != nil {
			return
		}
		if meta != nil {
			known++
		} else {
			unknown++
		}
	}
	slog.Info("Workspace cleanup inventory (report only)", "known", known, "deletionRecords", pending, "unknownPreserved", unknown, "truncated", truncated, "entryLimit", limit)
}

// Ownership is recorded only when SAM creates a previously absent exact subroot.
// Configured user roots and pre-existing directories are never adopted.
func (s *Server) createOwnedWorkspaceRoot(runtime *WorkspaceRuntime, root string) error {
	if s.store == nil || s.config.NodeUserID == "" || s.config.NodeRuntimeIncarnationID == "" || root != filepath.Join(s.config.WorkspaceDir, runtime.ID) || root == s.config.WorkspaceDir {
		return nil
	}
	if err := validateDeletionRoot(root); err != nil {
		return err
	}
	if _, err := os.Lstat(root); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	dev, ino, err := createOwnedWorkspaceDirectory(s.config.WorkspaceDir, runtime.ID)
	if err != nil {
		return err
	}
	proof := workspaceDeletionIntent{workspaceDeletionIdentity: workspaceDeletionIdentity{WorkspaceID: runtime.ID, NodeID: s.config.NodeID, NodeRuntimeIncarnationID: s.config.NodeRuntimeIncarnationID, UserID: s.config.NodeUserID}, Root: root, RootDevice: dev, RootInode: ino, Standalone: s.config.IsStandaloneMode()}
	payload, err := json.Marshal(proof)
	if err != nil {
		return err
	}
	return s.store.PutOwnedWorkspaceRoot(runtime.ID, string(payload))
}
