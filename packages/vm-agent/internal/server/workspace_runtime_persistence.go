package server

import (
	"errors"
	"log/slog"

	"github.com/workspace/vm-agent/internal/persistence"
)

var errWorkspaceMetadataUnavailable = errors.New("workspace metadata is unavailable")

// refreshWorkspaceEvictionState must run under the workspace lifecycle lock.
// Prepared stop intents are durable before Docker stops, so their marker can be
// newer than the in-memory lifecycle state after a failed or interrupted stop.
func (s *Server) refreshWorkspaceEvictionState(runtime *WorkspaceRuntime) (WorkspaceRuntime, error) {
	snapshot := s.snapshotWorkspaceRuntime(runtime)
	if snapshot.MetadataUnavailable {
		return snapshot, errWorkspaceMetadataUnavailable
	}
	if s.store == nil || snapshot.Status == "evicted" {
		return snapshot, nil
	}
	meta, err := s.store.GetWorkspaceMetadata(snapshot.ID)
	if err != nil || (meta != nil && meta.EvictionGeneration != snapshot.EvictionGeneration) {
		s.workspaceMu.Lock()
		runtime.MetadataUnavailable = true
		s.workspaceMu.Unlock()
		return snapshot, errWorkspaceMetadataUnavailable
	}
	if meta != nil && meta.Evicted {
		s.workspaceMu.Lock()
		runtime.Status = "evicted"
		runtime.UpdatedAt = nowUTC()
		snapshot = *runtime
		s.workspaceMu.Unlock()
	}
	return snapshot, nil
}

// persistWorkspaceMetadata writes workspace runtime state to SQLite for
// recovery after agent restarts. Callers must pass a snapshot or hold workspaceMu
// while reading mutable runtime fields.
func (s *Server) persistWorkspaceMetadata(runtime *WorkspaceRuntime) {
	if err := s.writeWorkspaceMetadata(runtime); err != nil {
		slog.Warn("Failed to persist workspace metadata", "workspace", runtime.ID, "error", err)
	}
}

func (s *Server) writeWorkspaceMetadata(runtime *WorkspaceRuntime) error {
	if s.store == nil || runtime == nil {
		return nil
	}
	return s.store.UpsertWorkspaceMetadata(persistence.WorkspaceMetadata{
		WorkspaceID:            runtime.ID,
		Repository:             runtime.Repository,
		Branch:                 runtime.Branch,
		BaseBranch:             runtime.BaseBranch,
		DefaultBranch:          runtime.DefaultBranch,
		ContainerWorkDir:       runtime.ContainerWorkDir,
		ContainerUser:          runtime.ContainerUser,
		ContainerLabelVal:      runtime.ContainerLabelValue,
		WorkspaceDir:           runtime.WorkspaceDir,
		CallbackToken:          runtime.CallbackToken,
		RepoProvider:           runtime.RepoProvider,
		CloneURL:               runtime.CloneURL,
		RepositoryHost:         runtime.RepositoryHost,
		RepositoryPath:         runtime.RepositoryPath,
		ProjectID:              runtime.ProjectID,
		ChatSessionID:          runtime.ChatSessionID,
		EvictionGeneration:     runtime.EvictionGeneration,
		Evicted:                runtime.Status == "evicted",
		Lightweight:            runtime.Lightweight,
		DevcontainerConfigName: runtime.DevcontainerConfigName,
	})
}
