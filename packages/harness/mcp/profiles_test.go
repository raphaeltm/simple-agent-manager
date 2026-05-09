package mcp

import (
	"context"
	"testing"

	"github.com/workspace/harness/tools"
)

// stubTool is a minimal tools.Tool for testing profile filtering.
type stubTool struct {
	name string
}

func (s *stubTool) Name() string                                              { return s.name }
func (s *stubTool) Description() string                                       { return "stub" }
func (s *stubTool) Schema() map[string]any                                    { return nil }
func (s *stubTool) Execute(_ context.Context, _ map[string]any) (string, error) { return "", nil }

func makeLocalTools() []tools.Tool {
	return []tools.Tool{
		&stubTool{name: "read_file"},
		&stubTool{name: "write_file"},
		&stubTool{name: "bash"},
	}
}

func makeMCPTools(client *Client) []tools.Tool {
	defs := []MCPToolDef{
		{Name: "get_task_details"},
		{Name: "update_task_status"},
		{Name: "complete_task"},
		{Name: "add_knowledge"},
		{Name: "search_knowledge"},
		{Name: "dispatch_task"},
		{Name: "create_mission"},
		{Name: "get_mission_state"},
		{Name: "list_tasks"},
		{Name: "send_message_to_subtask"},
		{Name: "stop_subtask"},
		{Name: "get_peer_agent_output"},
		{Name: "some_other_tool"},
	}
	return AdaptTools(client, defs)
}

func toolNames(tt []tools.Tool) map[string]bool {
	m := make(map[string]bool, len(tt))
	for _, t := range tt {
		m[t.Name()] = true
	}
	return m
}

func TestFilterToolsWorkspace(t *testing.T) {
	client := NewClient("http://unused", "token")
	allTools := append(makeLocalTools(), makeMCPTools(client)...)

	filtered := FilterTools(ProfileWorkspace, allTools)
	names := toolNames(filtered)

	// Local tools should always be present.
	for _, name := range []string{"read_file", "write_file", "bash"} {
		if !names[name] {
			t.Errorf("expected local tool %q in workspace profile", name)
		}
	}

	// Workspace MCP tools should be present.
	for _, name := range []string{"get_task_details", "update_task_status", "complete_task", "add_knowledge", "search_knowledge"} {
		if !names[name] {
			t.Errorf("expected MCP tool %q in workspace profile", name)
		}
	}

	// Orchestration-only tools should be excluded.
	for _, name := range []string{"dispatch_task", "create_mission", "stop_subtask", "some_other_tool"} {
		if names[name] {
			t.Errorf("did not expect MCP tool %q in workspace profile", name)
		}
	}
}

func TestFilterToolsOrchestrate(t *testing.T) {
	client := NewClient("http://unused", "token")
	allTools := append(makeLocalTools(), makeMCPTools(client)...)

	filtered := FilterTools(ProfileOrchestrate, allTools)
	names := toolNames(filtered)

	// Local tools should always be present.
	for _, name := range []string{"read_file", "write_file", "bash"} {
		if !names[name] {
			t.Errorf("expected local tool %q in orchestrate profile", name)
		}
	}

	// Orchestration MCP tools should be present.
	for _, name := range []string{"dispatch_task", "create_mission", "get_mission_state", "list_tasks", "send_message_to_subtask", "stop_subtask", "get_peer_agent_output", "get_task_details", "complete_task"} {
		if !names[name] {
			t.Errorf("expected MCP tool %q in orchestrate profile", name)
		}
	}

	// Non-orchestration tools should be excluded.
	if names["some_other_tool"] {
		t.Error("did not expect 'some_other_tool' in orchestrate profile")
	}
}

func TestFilterToolsFull(t *testing.T) {
	client := NewClient("http://unused", "token")
	allTools := append(makeLocalTools(), makeMCPTools(client)...)

	filtered := FilterTools(ProfileFull, allTools)
	if len(filtered) != len(allTools) {
		t.Errorf("full profile should include all %d tools, got %d", len(allTools), len(filtered))
	}
}

func TestFilterToolsUnknownProfile(t *testing.T) {
	client := NewClient("http://unused", "token")
	allTools := append(makeLocalTools(), makeMCPTools(client)...)

	filtered := FilterTools("nonexistent", allTools)
	if len(filtered) != len(allTools) {
		t.Errorf("unknown profile should include all %d tools, got %d", len(allTools), len(filtered))
	}
}

func TestFilterToolsLocalOnly(t *testing.T) {
	// When no MCP tools are present, all local tools should pass through.
	localOnly := makeLocalTools()
	for _, profile := range []string{ProfileWorkspace, ProfileOrchestrate, ProfileFull} {
		filtered := FilterTools(profile, localOnly)
		if len(filtered) != len(localOnly) {
			t.Errorf("profile %q: expected %d local tools, got %d", profile, len(localOnly), len(filtered))
		}
	}
}

func TestIsMCPTool(t *testing.T) {
	client := NewClient("http://unused", "token")
	mcpTools := AdaptTools(client, []MCPToolDef{{Name: "test"}})

	if !isMCPTool(mcpTools[0]) {
		t.Error("expected mcpTool to be identified as MCP tool")
	}

	local := &stubTool{name: "read_file"}
	if isMCPTool(local) {
		t.Error("expected stubTool to NOT be identified as MCP tool")
	}
}
