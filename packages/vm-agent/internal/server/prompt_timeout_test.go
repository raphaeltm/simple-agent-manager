package server

import (
	"context"
	"fmt"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/config"
	"io"
	"testing"
	"time"
)

func TestPromptTimeoutUsesSessionOwnershipNotNodeBootTask(t *testing.T) {
	s, _ := newMcpTestServer(t)
	s.config.TaskID = "boot-task"
	s.config.ProjectID = "boot-project"
	s.config.WorkspaceID = "boot-workspace"
	s.acpConfig.PromptTimeout = time.Hour
	s.sessionTaskCtx = map[string]taskCallbackContext{
		"other:task": {TaskID: "session-task", ProjectID: "project", WorkspaceID: "other"},
	}
	for _, tc := range []struct {
		workspace, session string
		want               time.Duration
	}{
		{"other", "task", 0},
		{"boot-workspace", "legacy-task", 0},
		{"other", "unmanaged", time.Hour},
	} {
		host := s.getOrCreateSessionHost(tc.workspace+":"+tc.session, tc.workspace, tc.session,
			agentsessions.Session{ID: tc.session, WorkspaceID: tc.workspace}, nil, "")
		if host == nil {
			t.Fatal("host not created")
		}
		t.Cleanup(host.Stop)
		if got := host.PromptTimeout(); got != tc.want {
			t.Errorf("%s: timeout %s, want %s", tc.session, got, tc.want)
		}
	}
}

func TestTaskFailureCallbackRetainsTypedCause(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{fmt.Errorf("rpc: %w", context.DeadlineExceeded), "agent_prompt_deadline_exceeded"},
		{fmt.Errorf("rpc: %w", io.EOF), "agent_crash"},
	} {
		body := runTaskCompletionCallback(t, config.TaskModeTask, "error", tc.err)
		if body["errorMessage"] != tc.want {
			t.Errorf("cause = %v, want %s", body["errorMessage"], tc.want)
		}
	}
}
