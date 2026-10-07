package server

import (
	"fmt"
	"strings"

	"github.com/workspace/vm-agent/internal/acp"
)

// A control-plane-resolved, credential-free contract. It is bound to the current
// authenticated workspace before restore admission, never to snapshot-provided routing.
type sessionRuntimeContract struct {
	Version          int                             `json:"version"`
	AgentType        string                          `json:"agentType"`
	Model            string                          `json:"model"`
	Effort           string                          `json:"effort"`
	PermissionMode   string                          `json:"permissionMode"`
	OpencodeProvider string                          `json:"opencodeProvider"`
	OpencodeBaseURL  string                          `json:"opencodeBaseUrl"`
	SettingsResolved bool                            `json:"settingsResolved"`
	AcpInteractions  acp.AcpInteractionRuntimeConfig `json:"acpInteractions"`
	TaskContext      *struct {
		ProjectID string `json:"projectId"`
		TaskID    string `json:"taskId"`
		TaskMode  string `json:"taskMode"`
	} `json:"taskContext"`
}

func (c *sessionRuntimeContract) validate(projectID, agentType string) error {
	if c == nil {
		return nil
	}
	if c.Version != 1 || !c.SettingsResolved || c.AgentType != agentType {
		return fmt.Errorf("invalid session runtime contract")
	}
	switch c.PermissionMode {
	case "default", "acceptEdits", "plan", "dontAsk", "bypassPermissions":
	default:
		return fmt.Errorf("invalid session permission mode")
	}
	if c.TaskContext != nil {
		if c.TaskContext.ProjectID != projectID || strings.TrimSpace(c.TaskContext.TaskID) == "" ||
			(c.TaskContext.TaskMode != "task" && c.TaskContext.TaskMode != "conversation") {
			return fmt.Errorf("session runtime task context conflicts")
		}
	}
	return acp.ValidateAcpInteractionRuntimeConfig(c.AcpInteractions)
}

// Called only after restore admission and the durable non-adoption fence. All
// host factories use this same mutex; no host can observe a partial contract.
func (s *Server) configureRestoredSession(input *sessionSnapshotHandlerInput) {
	key := input.workspaceID + ":" + input.sessionID
	s.sessionHostMu.Lock()
	defer s.sessionHostMu.Unlock()
	c := input.runtimeContract
	if c == nil {
		// A legacy caller cannot prove its former permission mode.
		s.sessionProfileOvr[key] = profileOverrides{PermissionMode: "default"}
		return
	}
	s.sessionProfileOvr[key] = profileOverrides{
		Model: c.Model, Effort: c.Effort, PermissionMode: c.PermissionMode,
		OpencodeProvider: c.OpencodeProvider, OpencodeBaseURL: c.OpencodeBaseURL,
		SettingsResolved: true,
	}
	if s.sessionManualInteractionConfig == nil {
		s.sessionManualInteractionConfig = make(map[string]acp.AcpInteractionRuntimeConfig)
	}
	s.sessionManualInteractionConfig[key] = c.AcpInteractions
	if s.sessionTaskCtx == nil {
		s.sessionTaskCtx = make(map[string]taskCallbackContext)
	}
	if c.TaskContext != nil {
		s.sessionTaskCtx[key] = taskCallbackContext{ProjectID: c.TaskContext.ProjectID, TaskID: c.TaskContext.TaskID, TaskMode: c.TaskContext.TaskMode, WorkspaceID: input.workspaceID}
	} else {
		delete(s.sessionTaskCtx, key)
	}
}
