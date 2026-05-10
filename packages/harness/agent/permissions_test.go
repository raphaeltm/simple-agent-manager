package agent

import (
	"context"
	"strings"
	"testing"

	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/tools"
	"github.com/workspace/harness/transcript"
)


// denyAllChecker always denies permission.
type denyAllChecker struct{}

func (denyAllChecker) CheckPermission(string, map[string]any, tools.DangerLevel) (bool, error) {
	return false, nil
}

// selectiveChecker denies only Dangerous tools.
type selectiveChecker struct{}

func (selectiveChecker) CheckPermission(_ string, _ map[string]any, level tools.DangerLevel) (bool, error) {
	return level != tools.Dangerous, nil
}

func TestPermission_AllowAll_ExecutesAll(t *testing.T) {
	registry := tools.NewRegistry()
	registry.Register(&tools.Bash{WorkDir: t.TempDir()})

	provider := llm.NewMockProvider(
		&llm.Response{
			Content: "Running bash",
			ToolCalls: []llm.ToolCall{{
				ID:     "call-1",
				Name:   "bash",
				Params: map[string]any{"command": "echo hello"},
			}},
		},
		&llm.Response{Content: "Done."},
	)

	result, err := Run(context.Background(), provider, registry, transcript.NewLog(), Config{
		MaxTurns:       5,
		PermissionMode: tools.PermissionAllowAll,
	}, "run echo")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}
}

func TestPermission_DenyDangerous_BlocksBash(t *testing.T) {
	registry := tools.NewRegistry()
	registry.Register(&tools.Bash{WorkDir: t.TempDir()})

	provider := llm.NewMockProvider(
		&llm.Response{
			Content: "Running bash",
			ToolCalls: []llm.ToolCall{{
				ID:     "call-1",
				Name:   "bash",
				Params: map[string]any{"command": "rm -rf /"},
			}},
		},
		&llm.Response{Content: "Permission denied, I'll stop."},
	)

	log := transcript.NewLog()
	result, err := Run(context.Background(), provider, registry, log, Config{
		MaxTurns:          5,
		PermissionMode:    tools.PermissionDenyDangerous,
		PermissionChecker: denyAllChecker{},
	}, "delete everything")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}

	// Verify the tool result was an error about permission denied.
	found := false
	for _, e := range log.Events() {
		if e.Type == transcript.EventToolResult {
			if data, ok := e.Data.(map[string]any); ok {
				if content, ok := data["content"].(string); ok && strings.Contains(content, "permission denied") {
					found = true
				}
			}
		}
	}
	if !found {
		t.Error("expected a tool result with permission denied error in transcript")
	}
}

func TestPermission_DenyDangerous_AllowsSafeTools(t *testing.T) {
	dir := t.TempDir()
	registry := tools.NewRegistry()
	registry.Register(&tools.Glob{WorkDir: dir})

	provider := llm.NewMockProvider(
		&llm.Response{
			Content: "Listing files",
			ToolCalls: []llm.ToolCall{{
				ID:     "call-1",
				Name:   "glob",
				Params: map[string]any{"pattern": "*"},
			}},
		},
		&llm.Response{Content: "Done."},
	)

	result, err := Run(context.Background(), provider, registry, transcript.NewLog(), Config{
		MaxTurns:          5,
		PermissionMode:    tools.PermissionDenyDangerous,
		PermissionChecker: denyAllChecker{}, // won't be called for safe tools
	}, "list files")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}
}

func TestPermission_AskAlways_DeniesEverything(t *testing.T) {
	dir := t.TempDir()
	registry := tools.NewRegistry()
	registry.Register(&tools.Glob{WorkDir: dir})

	provider := llm.NewMockProvider(
		&llm.Response{
			Content: "Listing files",
			ToolCalls: []llm.ToolCall{{
				ID:     "call-1",
				Name:   "glob",
				Params: map[string]any{"pattern": "*"},
			}},
		},
		&llm.Response{Content: "Can't do anything."},
	)

	log := transcript.NewLog()
	result, err := Run(context.Background(), provider, registry, log, Config{
		MaxTurns:          5,
		PermissionMode:    tools.PermissionAskAlways,
		PermissionChecker: denyAllChecker{},
	}, "list files")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}

	// Even safe tools should be denied in ask-always mode with deny checker.
	found := false
	for _, e := range log.Events() {
		if e.Type == transcript.EventToolResult {
			if data, ok := e.Data.(map[string]any); ok {
				if content, ok := data["content"].(string); ok && strings.Contains(content, "permission denied") {
					found = true
				}
			}
		}
	}
	if !found {
		t.Error("expected a tool result with permission denied error in transcript")
	}
}

func TestPermission_NoChecker_DeniesWhenRequired(t *testing.T) {
	registry := tools.NewRegistry()
	registry.Register(&tools.Bash{WorkDir: t.TempDir()})

	provider := llm.NewMockProvider(
		&llm.Response{
			Content: "Running bash",
			ToolCalls: []llm.ToolCall{{
				ID:     "call-1",
				Name:   "bash",
				Params: map[string]any{"command": "echo hi"},
			}},
		},
		&llm.Response{Content: "Stopped."},
	)

	log := transcript.NewLog()
	_, err := Run(context.Background(), provider, registry, log, Config{
		MaxTurns:          5,
		PermissionMode:    tools.PermissionDenyDangerous,
		PermissionChecker: nil, // no checker configured
	}, "run something")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	found := false
	for _, e := range log.Events() {
		if e.Type == transcript.EventToolResult {
			if data, ok := e.Data.(map[string]any); ok {
				if content, ok := data["content"].(string); ok && strings.Contains(content, "no checker is configured") {
					found = true
				}
			}
		}
	}
	if !found {
		t.Error("expected denial message about no checker configured")
	}
}
