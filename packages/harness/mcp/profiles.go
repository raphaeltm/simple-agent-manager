package mcp

import "github.com/workspace/harness/tools"

// Profile names for tool selection.
const (
	ProfileWorkspace   = "workspace"
	ProfileOrchestrate = "orchestrate"
	ProfileFull        = "full"
)

// workspaceMCPTools are the MCP tools exposed in the workspace profile.
// These support a coding agent working within a single workspace.
var workspaceMCPTools = map[string]bool{
	"get_task_details":    true,
	"update_task_status":  true,
	"complete_task":       true,
	"add_knowledge":       true,
	"search_knowledge":    true,
	"get_instructions":    true,
	"get_workspace_info":  true,
	"get_relevant_knowledge": true,
	"confirm_knowledge":   true,
	"get_project_knowledge": true,
	"ack_message":         true,
	"get_pending_messages": true,
	"send_durable_message": true,
}

// orchestrateMCPTools are the MCP tools exposed in the orchestrate profile.
// These support an orchestrator agent that dispatches and monitors subtasks.
var orchestrateMCPTools = map[string]bool{
	"dispatch_task":           true,
	"create_mission":          true,
	"get_mission":             true,
	"get_mission_state":       true,
	"publish_mission_state":   true,
	"list_tasks":              true,
	"search_tasks":            true,
	"get_task_details":        true,
	"update_task_status":      true,
	"complete_task":           true,
	"send_message_to_subtask": true,
	"stop_subtask":            true,
	"get_peer_agent_output":   true,
	"get_scheduling_queue":    true,
	"get_instructions":        true,
	"add_knowledge":           true,
	"search_knowledge":        true,
	"get_relevant_knowledge":  true,
	"confirm_knowledge":       true,
	"get_pending_messages":    true,
	"send_durable_message":    true,
	"ack_message":             true,
	"request_human_input":     true,
}

// ValidProfiles lists the recognized profile names.
var ValidProfiles = []string{ProfileWorkspace, ProfileOrchestrate, ProfileFull}

// FilterTools returns only the tools that belong to the named profile.
// The "full" profile passes all tools through unfiltered.
// Unknown profile names are treated as "full".
func FilterTools(profile string, allTools []tools.Tool) []tools.Tool {
	var allowed map[string]bool
	switch profile {
	case ProfileWorkspace:
		allowed = workspaceMCPTools
	case ProfileOrchestrate:
		allowed = orchestrateMCPTools
	default:
		// "full" or unknown: return everything.
		result := make([]tools.Tool, len(allTools))
		copy(result, allTools)
		return result
	}

	filtered := make([]tools.Tool, 0, len(allTools))
	for _, t := range allTools {
		if isMCPTool(t) {
			if allowed[t.Name()] {
				filtered = append(filtered, t)
			}
		} else {
			// Local tools always pass through.
			filtered = append(filtered, t)
		}
	}
	return filtered
}

// isMCPTool checks whether a tool is an MCP-adapted tool.
func isMCPTool(t tools.Tool) bool {
	_, ok := t.(*mcpTool)
	return ok
}
