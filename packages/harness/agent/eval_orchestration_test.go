package agent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/tools"
	"github.com/workspace/harness/transcript"
)

// mockTool is a simple test tool that returns a fixed response.
type mockTool struct {
	name        string
	description string
	schema      map[string]any
	response    string
	calls       []map[string]any
}

func (m *mockTool) Name() string          { return m.name }
func (m *mockTool) Description() string    { return m.description }
func (m *mockTool) Schema() map[string]any { return m.schema }
func (m *mockTool) Execute(_ context.Context, params map[string]any) (string, error) {
	m.calls = append(m.calls, params)
	return m.response, nil
}

// Eval Task: Orchestrator decomposes a multi-step task into subtask dispatches.
// The orchestrator identifies that a complex task requires delegation, dispatches
// subtasks, monitors them, and composes a final result.
func TestEval_OrchestratorDecomposition(t *testing.T) {
	// Mock tools that simulate SAM MCP orchestration tools.
	dispatchTool := &mockTool{
		name:        "dispatch_task",
		description: "Dispatch a subtask to a child agent",
		schema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"title":       map[string]any{"type": "string"},
				"description": map[string]any{"type": "string"},
			},
			"required": []any{"title", "description"},
		},
		response: `{"taskId": "task-001", "status": "dispatched"}`,
	}

	getTaskTool := &mockTool{
		name:        "get_task_details",
		description: "Get details and status of a task",
		schema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"taskId": map[string]any{"type": "string"},
			},
			"required": []any{"taskId"},
		},
		response: `{"taskId": "task-001", "status": "completed", "output": "Implemented the login endpoint with JWT validation."}`,
	}

	completeTool := &mockTool{
		name:        "complete_task",
		description: "Mark the current task as complete with a summary",
		schema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"summary": map[string]any{"type": "string"},
			},
			"required": []any{"summary"},
		},
		response: `{"success": true}`,
	}

	// Simulate the orchestrator decomposing "Build auth system" into subtasks.
	provider := llm.NewMockProvider(
		// Turn 1: orchestrator reads the task and decides to dispatch subtasks
		&llm.Response{
			Content: "I'll decompose this into two subtasks: (1) implement login endpoint, (2) implement token refresh.",
			ToolCalls: []llm.ToolCall{
				{
					ID:   "d1",
					Name: "dispatch_task",
					Params: map[string]any{
						"title":       "Implement login endpoint",
						"description": "Create POST /api/auth/login that validates credentials and returns a JWT token.",
					},
				},
				{
					ID:   "d2",
					Name: "dispatch_task",
					Params: map[string]any{
						"title":       "Implement token refresh",
						"description": "Create POST /api/auth/refresh that accepts a refresh token and returns a new access token.",
					},
				},
			},
		},
		// Turn 2: check status of subtasks
		&llm.Response{
			ToolCalls: []llm.ToolCall{
				{
					ID:     "g1",
					Name:   "get_task_details",
					Params: map[string]any{"taskId": "task-001"},
				},
			},
		},
		// Turn 3: compose final output and complete
		&llm.Response{
			Content: "Both subtasks completed. Auth system is implemented with login and token refresh endpoints.",
			ToolCalls: []llm.ToolCall{
				{
					ID:   "c1",
					Name: "complete_task",
					Params: map[string]any{
						"summary": "Auth system implemented: login endpoint with JWT, token refresh endpoint. Both subtasks completed successfully.",
					},
				},
			},
		},
		// Turn 4: final message after completing
		&llm.Response{Content: "Task complete. The auth system has been implemented via two subtasks."},
	)

	registry := tools.NewRegistry()
	registry.Register(dispatchTool)
	registry.Register(getTaskTool)
	registry.Register(completeTool)

	log := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, log, Config{
		SystemPrompt: "You are an orchestrator agent. Decompose complex tasks into subtasks using dispatch_task.",
		MaxTurns:     10,
	}, "Build a complete auth system with login and token refresh")

	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}

	// Assert: dispatch_task was called at least twice (decomposition happened)
	if len(dispatchTool.calls) < 2 {
		t.Errorf("dispatch_task called %d times, want at least 2", len(dispatchTool.calls))
	}

	// Assert: first dispatch has a meaningful title
	if len(dispatchTool.calls) > 0 {
		title, _ := dispatchTool.calls[0]["title"].(string)
		if title == "" {
			t.Error("first dispatch_task call has empty title")
		}
		desc, _ := dispatchTool.calls[0]["description"].(string)
		if desc == "" {
			t.Error("first dispatch_task call has empty description")
		}
	}

	// Assert: get_task_details was called (monitoring happened)
	if len(getTaskTool.calls) == 0 {
		t.Error("get_task_details was never called — orchestrator did not monitor subtasks")
	}

	// Assert: complete_task was called with a summary
	if len(completeTool.calls) == 0 {
		t.Error("complete_task was never called — orchestrator did not report completion")
	} else {
		summary, _ := completeTool.calls[0]["summary"].(string)
		if summary == "" {
			t.Error("complete_task called with empty summary")
		}
	}

	// Assert: transcript shows the decomposition pattern
	var dispatchEvents int
	for _, e := range log.Events() {
		if e.Type == transcript.EventToolCall {
			if d, ok := e.Data.(map[string]any); ok {
				if name, _ := d["name"].(string); name == "dispatch_task" {
					dispatchEvents++
				}
			}
		}
	}
	if dispatchEvents < 2 {
		t.Errorf("transcript shows %d dispatch events, want at least 2", dispatchEvents)
	}
}

// Eval Task: Orchestrator handles subtask failure gracefully.
// When a subtask fails, the orchestrator reports the issue without crashing.
func TestEval_OrchestratorFailureHandling(t *testing.T) {
	dispatchTool := &mockTool{
		name:        "dispatch_task",
		description: "Dispatch a subtask to a child agent",
		schema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"title":       map[string]any{"type": "string"},
				"description": map[string]any{"type": "string"},
			},
			"required": []any{"title", "description"},
		},
		response: `{"taskId": "task-002", "status": "dispatched"}`,
	}

	// Simulate a failed subtask
	getTaskTool := &mockTool{
		name:        "get_task_details",
		description: "Get details and status of a task",
		schema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"taskId": map[string]any{"type": "string"},
			},
			"required": []any{"taskId"},
		},
		response: `{"taskId": "task-002", "status": "failed", "error": "Build failed: missing dependency express@4.x"}`,
	}

	updateStatusTool := &mockTool{
		name:        "update_task_status",
		description: "Update the current task's status",
		schema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"status": map[string]any{"type": "string"},
				"note":   map[string]any{"type": "string"},
			},
		},
		response: `{"success": true}`,
	}

	requestHumanTool := &mockTool{
		name:        "request_human_input",
		description: "Request input from a human operator",
		schema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"question": map[string]any{"type": "string"},
			},
			"required": []any{"question"},
		},
		response: `{"acknowledged": true}`,
	}

	provider := llm.NewMockProvider(
		// Turn 1: dispatch the subtask
		&llm.Response{
			Content: "I'll dispatch a subtask to set up the API server.",
			ToolCalls: []llm.ToolCall{{
				ID:   "d1",
				Name: "dispatch_task",
				Params: map[string]any{
					"title":       "Set up Express API server",
					"description": "Initialize an Express.js API server with health endpoint.",
				},
			}},
		},
		// Turn 2: check status — discovers failure
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "g1",
				Name:   "get_task_details",
				Params: map[string]any{"taskId": "task-002"},
			}},
		},
		// Turn 3: report the failure and request human input
		&llm.Response{
			Content: "Subtask failed due to missing dependency. Reporting to human for resolution.",
			ToolCalls: []llm.ToolCall{
				{
					ID:   "u1",
					Name: "update_task_status",
					Params: map[string]any{
						"status": "blocked",
						"note":   "Subtask 'Set up Express API server' failed: missing dependency express@4.x",
					},
				},
				{
					ID:   "h1",
					Name: "request_human_input",
					Params: map[string]any{
						"question": "Subtask failed with: 'Build failed: missing dependency express@4.x'. Should I retry with a different approach or add the dependency first?",
					},
				},
			},
		},
		// Turn 4: final summary noting the failure
		&llm.Response{Content: "Task blocked. Subtask failed due to missing express@4.x dependency. Requested human guidance on how to proceed."},
	)

	registry := tools.NewRegistry()
	registry.Register(dispatchTool)
	registry.Register(getTaskTool)
	registry.Register(updateStatusTool)
	registry.Register(requestHumanTool)

	log := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, log, Config{
		SystemPrompt: "You are an orchestrator agent. When subtasks fail, report the failure clearly and request human input if needed.",
		MaxTurns:     10,
	}, "Set up the API server for the project")

	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}

	// Assert: the orchestrator did not crash or loop endlessly
	if result.TurnsUsed > 6 {
		t.Errorf("used %d turns, expected graceful handling in <=6", result.TurnsUsed)
	}

	// Assert: the failure was detected (get_task_details was called)
	if len(getTaskTool.calls) == 0 {
		t.Error("orchestrator did not check subtask status")
	}

	// Assert: human was notified about the failure
	if len(requestHumanTool.calls) == 0 {
		t.Error("orchestrator did not request human input after failure")
	} else {
		question, _ := requestHumanTool.calls[0]["question"].(string)
		if !strings.Contains(strings.ToLower(question), "fail") && !strings.Contains(strings.ToLower(question), "express") {
			t.Errorf("human input request does not reference the failure: %s", question)
		}
	}

	// Assert: status was updated to reflect the blocker
	if len(updateStatusTool.calls) == 0 {
		t.Error("orchestrator did not update task status after failure")
	} else {
		note, _ := updateStatusTool.calls[0]["note"].(string)
		if note == "" {
			t.Error("status update has empty note")
		}
	}

	// Assert: final message acknowledges the failure (not a success claim)
	lower := strings.ToLower(result.FinalMessage)
	if strings.Contains(lower, "successfully") || strings.Contains(lower, "all done") {
		t.Errorf("final message incorrectly claims success despite failure: %s", result.FinalMessage)
	}

	// Verify we can serialize the full transcript (no panics on complex tool data)
	_, err = json.Marshal(log.Events())
	if err != nil {
		t.Errorf("transcript serialization failed: %v", err)
	}
}
