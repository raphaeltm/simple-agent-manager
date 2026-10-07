package server

import (
	"reflect"
	"testing"

	"github.com/workspace/vm-agent/internal/acp"
)

func restoredTestContract() *sessionRuntimeContract {
	return &sessionRuntimeContract{
		Version: 1, AgentType: "codex", Model: "gpt-6.1-sol", Effort: "high", PermissionMode: "default", SettingsResolved: true,
		AcpInteractions: acp.AcpInteractionRuntimeConfig{ProtocolVersion: 1},
	}
}

func TestRestoredContractValidationFailsClosed(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*sessionRuntimeContract)
	}{
		{"future version", func(c *sessionRuntimeContract) { c.Version = 2 }},
		{"unresolved", func(c *sessionRuntimeContract) { c.SettingsResolved = false }},
		{"agent mismatch", func(c *sessionRuntimeContract) { c.AgentType = "claude-code" }},
		{"invalid permission", func(c *sessionRuntimeContract) { c.PermissionMode = "manual-typo" }},
		{"cross-project task", func(c *sessionRuntimeContract) {
			c.TaskContext = &struct {
				ProjectID string `json:"projectId"`
				TaskID    string `json:"taskId"`
				TaskMode  string `json:"taskMode"`
			}{"other", "original-task", "task"}
		}},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			c := restoredTestContract()
			tt.mutate(c)
			if c.validate("project", "codex") == nil {
				t.Fatal("invalid contract accepted")
			}
		})
	}
	if err := restoredTestContract().validate("project", "codex"); err != nil {
		t.Fatal(err)
	}
	var legacy *sessionRuntimeContract
	if err := legacy.validate("project", "codex"); err != nil {
		t.Fatal(err)
	}
}

func TestRestoreContractRepopulatesHostMapsAndClearsStaleTask(t *testing.T) {
	s, _ := newMcpTestServer(t)
	c := restoredTestContract()
	c.PermissionMode = "plan"
	c.TaskContext = &struct {
		ProjectID string `json:"projectId"`
		TaskID    string `json:"taskId"`
		TaskMode  string `json:"taskMode"`
	}{"project", "original-task", "task"}
	input := &sessionSnapshotHandlerInput{workspaceID: "ws", sessionID: "restored", runtimeContract: c}
	s.configureRestoredSession(input)
	key := "ws:restored"
	ovr := s.sessionProfileOvr[key]
	if !ovr.SettingsResolved || ovr.Model != "gpt-6.1-sol" || ovr.PermissionMode != "plan" || ovr.Effort != "high" {
		t.Fatalf("lost profile: %+v", ovr)
	}
	if !reflect.DeepEqual(s.sessionManualInteractionConfig[key], c.AcpInteractions) {
		t.Fatal("lost interaction contract")
	}
	if got := s.sessionTaskCtx[key]; got.TaskID != "original-task" || got.TaskMode != "task" || got.ProjectID != "project" || got.WorkspaceID != "ws" {
		t.Fatalf("lost task callback: %+v", got)
	}
	c.TaskContext = nil
	s.configureRestoredSession(input)
	if _, ok := s.sessionTaskCtx[key]; ok {
		t.Fatal("chat restore retained stale task callback")
	}
	input.runtimeContract = nil
	s.configureRestoredSession(input)
	if got := s.sessionProfileOvr[key]; got.PermissionMode != "default" {
		t.Fatalf("legacy restore permits unsafe defaults: %+v", got)
	}
}

func TestRestoreContractInteractionsReachActualHost(t *testing.T) {
	s, _ := newMcpTestServer(t)
	c := restoredTestContract()
	c.AcpInteractions = acp.AcpInteractionRuntimeConfig{
		Enabled: true, URLsEnabled: true, ProtocolVersion: 1,
		PermissionDeadlineMs: 1000, URLDeadlineMs: 1000, MaxDeadlineMs: 2000,
		DeadlineMarginMs: 100, RequestMaxBytes: 32768, OptionsMaxCount: 16,
		OptionIDMaxChars: 128, OptionNameMaxChars: 200, ReceiptLimit: 16,
		ResponseMaxBytes: 65536, URLMaxChars: 2048, URLElicitationIDMaxChars: 128,
		SettleRetryDelaysMs: []int{10}, SettleRetrySteadyMs: 100,
	}
	if err := c.validate("project", "codex"); err != nil {
		t.Fatal(err)
	}
	runtime := &WorkspaceRuntime{ID: "ws", ProjectID: "project", Status: "running", CallbackToken: "callback"}
	s.workspaces["ws"] = runtime
	session, _, err := s.agentSessions.Create("ws", "restored", "Restored", "")
	if err != nil {
		t.Fatal(err)
	}
	s.configureRestoredSession(&sessionSnapshotHandlerInput{workspaceID: "ws", sessionID: "restored", runtimeContract: c})
	host := s.getOrCreateSessionHost("ws:restored", "ws", "restored", session, runtime, "")
	if host == nil || !host.AcpInteractionBridgeEnabled() {
		t.Fatal("restored interaction contract did not reach SessionHost")
	}
	s.stopSessionHost("ws", "restored")
}
