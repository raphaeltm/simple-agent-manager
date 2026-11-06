package server

import (
	"strings"

	"github.com/workspace/vm-agent/internal/config"
)

// samIdentity is the SAM identity one workspace's agent and shells see as
// SAM_PROJECT_ID, SAM_CHAT_SESSION_ID, SAM_TASK_ID and SAM_TASK_MODE.
type samIdentity struct {
	ProjectID     string
	ChatSessionID string
	TaskID        string
	TaskMode      string
}

// workspaceSAMIdentity resolves the SAM identity for one workspace.
//
// s.config describes the session that booted the node. A node hosts many
// workspaces over its life, so only that boot workspace may fall back to it;
// any other workspace uses its own runtime values, and an unknown value stays
// empty rather than borrowing another session's. The session's task context
// (sent on agent-session start) beats both, because it is the only source that
// knows the task mode of the session actually running.
func (s *Server) workspaceSAMIdentity(workspaceID string, runtime *WorkspaceRuntime, task *taskCallbackContext) samIdentity {
	var id samIdentity
	if runtime != nil {
		// The runtime is the shared map entry; upsertWorkspaceRuntime writes these
		// fields under workspaceMu. Callers must not hold workspaceMu.
		s.workspaceMu.RLock()
		id.ProjectID = strings.TrimSpace(runtime.ProjectID)
		id.ChatSessionID = strings.TrimSpace(runtime.ChatSessionID)
		id.TaskID = strings.TrimSpace(runtime.TaskID)
		s.workspaceMu.RUnlock()
	}
	if task != nil {
		id.ProjectID = firstNonEmpty(strings.TrimSpace(task.ProjectID), id.ProjectID)
		id.TaskID = firstNonEmpty(strings.TrimSpace(task.TaskID), id.TaskID)
		id.TaskMode = strings.TrimSpace(task.TaskMode)
	}

	boot := s.config
	if boot == nil || workspaceID == "" || workspaceID != strings.TrimSpace(boot.WorkspaceID) {
		return id
	}
	id.ProjectID = firstNonEmpty(id.ProjectID, strings.TrimSpace(boot.ProjectID))
	id.ChatSessionID = firstNonEmpty(id.ChatSessionID, strings.TrimSpace(boot.ChatSessionID))
	id.TaskID = firstNonEmpty(id.TaskID, strings.TrimSpace(boot.TaskID))
	// TASK_MODE defaults to "task" when unset (Instant containers never set it),
	// so the boot mode only describes the boot task, never a task it didn't name.
	if id.TaskMode == "" && id.TaskID != "" && id.TaskID == strings.TrimSpace(boot.TaskID) {
		id.TaskMode = strings.TrimSpace(boot.TaskMode)
	}
	return id
}

// applyTo replaces cfg's identity, including with empty values, so a copy of
// the node config never keeps the boot session's identity.
func (id samIdentity) applyTo(cfg *config.Config) {
	cfg.ProjectID = id.ProjectID
	cfg.ChatSessionID = id.ChatSessionID
	cfg.TaskID = id.TaskID
	cfg.TaskMode = id.TaskMode
}

// workspaceBootstrapConfig is the node config re-pointed at one workspace, for
// provisioning and recovery. It never keeps the boot session's identity, which
// bootstrap writes into /etc/sam/env and /etc/profile.d/sam-env.sh.
func (s *Server) workspaceBootstrapConfig(runtime *WorkspaceRuntime, callbackToken string) config.Config {
	cfg := *s.config
	cfg.WorkspaceID = runtime.ID
	cfg.Repository = strings.TrimSpace(runtime.Repository)
	cfg.Branch = strings.TrimSpace(runtime.Branch)
	cfg.BaseBranch = strings.TrimSpace(runtime.BaseBranch)
	cfg.RepoProvider = strings.TrimSpace(runtime.RepoProvider)
	cfg.CloneURL = strings.TrimSpace(runtime.CloneURL)
	cfg.RepositoryHost = strings.TrimSpace(runtime.RepositoryHost)
	cfg.RepositoryPath = strings.TrimSpace(runtime.RepositoryPath)
	cfg.WorkspaceDir = strings.TrimSpace(runtime.WorkspaceDir)
	cfg.ContainerLabelValue = strings.TrimSpace(runtime.ContainerLabelValue)
	cfg.ContainerWorkDir = strings.TrimSpace(runtime.ContainerWorkDir)
	cfg.ContainerUser = strings.TrimSpace(runtime.ContainerUser)
	if cfg.ContainerUser == "" {
		cfg.ContainerUser = strings.TrimSpace(s.config.ContainerUser)
	}
	cfg.CallbackToken = callbackToken
	applyDevcontainerCacheCredentials(&cfg, runtime.DevcontainerCache)
	s.workspaceSAMIdentity(runtime.ID, runtime, nil).applyTo(&cfg)
	return cfg
}

// sessionSAMEnvFallback is the SAM env a session's agent gets for any key its
// container env files lack. It is built per session because SAM_TASK_MODE only
// ever comes from here, and a node-level list would give every session on the
// node the boot session's mode and IDs.
func (s *Server) sessionSAMEnvFallback(workspaceID string, runtime *WorkspaceRuntime, task *taskCallbackContext) []string {
	if s.config == nil {
		return nil
	}
	cfg := *s.config
	cfg.WorkspaceID = workspaceID
	if runtime != nil {
		cfg.Repository = strings.TrimSpace(runtime.Repository)
		cfg.Branch = strings.TrimSpace(runtime.Branch)
	} else if workspaceID != strings.TrimSpace(s.config.WorkspaceID) {
		cfg.Repository = ""
		cfg.Branch = ""
	}
	s.workspaceSAMIdentity(workspaceID, runtime, task).applyTo(&cfg)
	return cfg.BuildSAMEnvFallback()
}
