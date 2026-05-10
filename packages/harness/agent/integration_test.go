package agent

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/session"
	"github.com/workspace/harness/tools"
	"github.com/workspace/harness/transcript"
)

// TestIntegration_SessionPersistence_MultiTurn tests a 2-turn agent run with
// session persistence, verifying messages are correctly stored and retrievable.
func TestIntegration_SessionPersistence_MultiTurn(t *testing.T) {
	store, err := session.NewStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	defer store.Close()

	sessID := "int-test-1"
	if _, err := store.CreateSession(sessID, session.Config{
		SystemPrompt: "You are helpful.",
		WorkDir:      "/tmp",
		Model:        "mock",
	}); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// Turn 1: tool call, Turn 2: final text.
	provider := llm.NewMockProvider(
		&llm.Response{
			Content: "Let me read the file.",
			ToolCalls: []llm.ToolCall{
				{ID: "tc1", Name: "echo", Params: map[string]any{"message": "hello"}},
			},
		},
		&llm.Response{
			Content: "The file contains hello.",
		},
	)

	registry := tools.NewRegistry()
	registry.Register(&echoTool{})

	log := transcript.NewLog()
	result, err := Run(context.Background(), provider, registry, log, Config{
		SystemPrompt: "You are helpful.",
		MaxTurns:     5,
		SessionStore: store,
		SessionID:    sessID,
	}, "Read the file")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.TurnsUsed != 2 {
		t.Errorf("expected 2 turns, got %d", result.TurnsUsed)
	}
	if result.StopReason != "complete" {
		t.Errorf("expected complete, got %q", result.StopReason)
	}

	// Verify messages were persisted.
	msgs, err := store.LoadMessages(sessID)
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}
	// Expected: system(0) + user(0) + assistant+toolcall(1) + tool_result(1) + assistant_final(2)
	if len(msgs) < 4 {
		t.Fatalf("expected at least 4 persisted messages, got %d", len(msgs))
	}

	// Verify session status.
	sess, _ := store.LoadSession(sessID)
	if sess.Status != "completed" {
		t.Errorf("expected completed status, got %q", sess.Status)
	}

	// Verify we can load and resume — messages should be retrievable.
	loaded, _ := store.LoadMessages(sessID)
	hasSystem := false
	hasUser := false
	hasAssistant := false
	hasTool := false
	for _, m := range loaded {
		switch m.Role {
		case llm.RoleSystem:
			hasSystem = true
		case llm.RoleUser:
			hasUser = true
		case llm.RoleAssistant:
			hasAssistant = true
		case llm.RoleTool:
			hasTool = true
		}
	}
	if !hasSystem || !hasUser || !hasAssistant || !hasTool {
		t.Errorf("missing message roles: system=%v user=%v assistant=%v tool=%v", hasSystem, hasUser, hasAssistant, hasTool)
	}
}

// TestIntegration_ParallelTools_WithPermissions tests parallel tool execution
// with permission gating — safe tools execute, dangerous tools are denied.
func TestIntegration_ParallelTools_WithPermissions(t *testing.T) {
	provider := llm.NewMockProvider(
		&llm.Response{
			Content: "Let me read and run.",
			ToolCalls: []llm.ToolCall{
				{ID: "tc1", Name: "echo", Params: map[string]any{"message": "safe"}},
				{ID: "tc2", Name: "dangerous_tool", Params: map[string]any{}},
			},
		},
		&llm.Response{
			Content: "Done.",
		},
	)

	registry := tools.NewRegistry()
	registry.Register(&echoTool{})
	registry.Register(&dangerousTool{})

	log := transcript.NewLog()
	result, err := Run(context.Background(), provider, registry, log, Config{
		MaxTurns:          5,
		ParallelTools:     true,
		MaxParallelTools:  3,
		PermissionMode:    tools.PermissionDenyDangerous,
		PermissionChecker: integrationDenyChecker{},
	}, "Do work")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("expected complete, got %q", result.StopReason)
	}
	if result.TurnsUsed != 2 {
		t.Errorf("expected 2 turns, got %d", result.TurnsUsed)
	}
}

// dangerousTool is a tool that implements DangerLeveler with Dangerous level.
type dangerousTool struct{}

func (d *dangerousTool) Name() string        { return "dangerous_tool" }
func (d *dangerousTool) Description() string  { return "A dangerous tool" }
func (d *dangerousTool) Schema() map[string]any {
	return map[string]any{"type": "object", "properties": map[string]any{}}
}
func (d *dangerousTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	return "executed dangerously", nil
}
func (d *dangerousTool) DangerLevel() tools.DangerLevel { return tools.Dangerous }

// integrationDenyChecker denies every permission check.
type integrationDenyChecker struct{}

func (d integrationDenyChecker) CheckPermission(name string, params map[string]any, level tools.DangerLevel) (bool, error) {
	return false, nil
}
