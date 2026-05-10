// Package tools provides mock orchestration tools for evaluating LLM orchestration behavior.
// These tools simulate SAM MCP orchestration tools (dispatch_task, get_task_details, etc.)
// with stateful responses, allowing real models to be tested on orchestration decision-making
// without requiring a live SAM MCP server.
package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// MockOrchestrationState tracks the state of dispatched subtasks across all mock tools.
// This allows get_task_details to return evolving status based on when dispatch happened.
type MockOrchestrationState struct {
	mu       sync.Mutex
	tasks    map[string]*mockTask
	taskSeq  int
	scenario string // controls failure behavior
}

type mockTask struct {
	ID          string
	Title       string
	Description string
	Status      string // dispatched, in_progress, completed, failed
	Output      string
	Error       string
	DispatchedAt time.Time
	PollCount   int
}

// NewMockOrchestrationState creates a new orchestration state tracker.
// scenario controls behavior:
//   - "success": all tasks complete successfully after 1 poll
//   - "failure": first task fails, subsequent succeed
//   - "mixed": first task succeeds, second fails, third succeeds
func NewMockOrchestrationState(scenario string) *MockOrchestrationState {
	return &MockOrchestrationState{
		tasks:    make(map[string]*mockTask),
		scenario: scenario,
	}
}

// MockDispatchTask simulates dispatch_task — accepts title+description, returns task ID.
type MockDispatchTask struct {
	State *MockOrchestrationState
}

func (t *MockDispatchTask) Name() string        { return "dispatch_task" }
func (t *MockDispatchTask) Description() string {
	return "Dispatch a subtask to a child agent for execution. Provide a clear title and detailed description with all context the child needs."
}
func (t *MockDispatchTask) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"title":       map[string]any{"type": "string", "description": "Short title for the subtask"},
			"description": map[string]any{"type": "string", "description": "Detailed description with context, file paths, and acceptance criteria"},
		},
		"required": []any{"title", "description"},
	}
}

func (t *MockDispatchTask) Execute(_ context.Context, params map[string]any) (string, error) {
	title, _ := params["title"].(string)
	desc, _ := params["description"].(string)

	if title == "" {
		return "", fmt.Errorf("title is required")
	}

	t.State.mu.Lock()
	defer t.State.mu.Unlock()

	t.State.taskSeq++
	id := fmt.Sprintf("task-%03d", t.State.taskSeq)

	t.State.tasks[id] = &mockTask{
		ID:           id,
		Title:        title,
		Description:  desc,
		Status:       "dispatched",
		DispatchedAt: time.Now(),
	}

	resp := map[string]any{
		"taskId": id,
		"status": "dispatched",
		"title":  title,
	}
	data, _ := json.Marshal(resp)
	return string(data), nil
}

// MockGetTaskDetails simulates get_task_details — returns evolving status.
type MockGetTaskDetails struct {
	State *MockOrchestrationState
}

func (t *MockGetTaskDetails) Name() string        { return "get_task_details" }
func (t *MockGetTaskDetails) Description() string {
	return "Get the current status and details of a dispatched subtask by its task ID."
}
func (t *MockGetTaskDetails) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"taskId": map[string]any{"type": "string", "description": "The task ID returned from dispatch_task"},
		},
		"required": []any{"taskId"},
	}
}

func (t *MockGetTaskDetails) Execute(_ context.Context, params map[string]any) (string, error) {
	taskID, _ := params["taskId"].(string)
	if taskID == "" {
		return "", fmt.Errorf("taskId is required")
	}

	t.State.mu.Lock()
	defer t.State.mu.Unlock()

	task, ok := t.State.tasks[taskID]
	if !ok {
		return "", fmt.Errorf("task not found: %s", taskID)
	}

	task.PollCount++

	// Evolve status based on scenario and poll count.
	if task.Status == "dispatched" || task.Status == "in_progress" {
		task.Status = "in_progress"

		switch t.State.scenario {
		case "failure":
			// First task fails, rest succeed.
			if taskID == "task-001" && task.PollCount >= 1 {
				task.Status = "failed"
				task.Error = "Build failed: undefined reference to 'validateToken' in middleware/auth.go:42. The function was moved to a new package but the import was not updated."
			} else if task.PollCount >= 2 {
				task.Status = "completed"
				task.Output = fmt.Sprintf("Successfully completed: %s", task.Title)
			}
		case "mixed":
			// First succeeds, second fails, third succeeds.
			if taskID == "task-002" && task.PollCount >= 1 {
				task.Status = "failed"
				task.Error = "Test failure: TestRateLimitMiddleware/concurrent_requests expected 429 status but got 200. The rate limiter is not thread-safe."
			} else if task.PollCount >= 2 {
				task.Status = "completed"
				task.Output = fmt.Sprintf("Successfully completed: %s", task.Title)
			}
		default: // "success"
			if task.PollCount >= 1 {
				task.Status = "completed"
				task.Output = fmt.Sprintf("Successfully completed: %s. All tests passing.", task.Title)
			}
		}
	}

	resp := map[string]any{
		"taskId": task.ID,
		"title":  task.Title,
		"status": task.Status,
	}
	if task.Output != "" {
		resp["output"] = task.Output
	}
	if task.Error != "" {
		resp["error"] = task.Error
	}
	data, _ := json.Marshal(resp)
	return string(data), nil
}

// MockCompleteTask simulates complete_task.
type MockCompleteTask struct {
	State *MockOrchestrationState
	// Calls records each invocation for test assertions.
	Calls []map[string]any
}

func (t *MockCompleteTask) Name() string        { return "complete_task" }
func (t *MockCompleteTask) Description() string {
	return "Mark the current orchestration task as complete with a summary of what was accomplished."
}
func (t *MockCompleteTask) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"summary": map[string]any{"type": "string", "description": "Summary of what was accomplished across all subtasks"},
		},
		"required": []any{"summary"},
	}
}

func (t *MockCompleteTask) Execute(_ context.Context, params map[string]any) (string, error) {
	t.Calls = append(t.Calls, params)
	return `{"success": true}`, nil
}

// MockUpdateTaskStatus simulates update_task_status.
type MockUpdateTaskStatus struct {
	State *MockOrchestrationState
	Calls []map[string]any
}

func (t *MockUpdateTaskStatus) Name() string        { return "update_task_status" }
func (t *MockUpdateTaskStatus) Description() string {
	return "Update the status of the current orchestration task with a note about progress."
}
func (t *MockUpdateTaskStatus) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"status": map[string]any{"type": "string", "description": "New status: in_progress, blocked, completed"},
			"note":   map[string]any{"type": "string", "description": "Brief note about what happened"},
		},
	}
}

func (t *MockUpdateTaskStatus) Execute(_ context.Context, params map[string]any) (string, error) {
	t.Calls = append(t.Calls, params)
	return `{"success": true}`, nil
}

// MockRequestHumanInput simulates request_human_input.
type MockRequestHumanInput struct {
	Calls []map[string]any
}

func (t *MockRequestHumanInput) Name() string        { return "request_human_input" }
func (t *MockRequestHumanInput) Description() string {
	return "Request input from a human operator when you encounter a problem you cannot resolve autonomously."
}
func (t *MockRequestHumanInput) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"question": map[string]any{"type": "string", "description": "Clear description of what you need from the human"},
		},
		"required": []any{"question"},
	}
}

func (t *MockRequestHumanInput) Execute(_ context.Context, params map[string]any) (string, error) {
	t.Calls = append(t.Calls, params)
	return `{"acknowledged": true, "message": "Human has been notified. Proceed with other work while waiting."}`, nil
}

// MockListTasks simulates list_tasks — returns all tracked tasks.
type MockListTasks struct {
	State *MockOrchestrationState
}

func (t *MockListTasks) Name() string        { return "list_tasks" }
func (t *MockListTasks) Description() string {
	return "List all subtasks that have been dispatched, with their current status."
}
func (t *MockListTasks) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{},
	}
}

func (t *MockListTasks) Execute(_ context.Context, _ map[string]any) (string, error) {
	t.State.mu.Lock()
	defer t.State.mu.Unlock()

	tasks := make([]map[string]any, 0, len(t.State.tasks))
	for _, task := range t.State.tasks {
		entry := map[string]any{
			"taskId": task.ID,
			"title":  task.Title,
			"status": task.Status,
		}
		tasks = append(tasks, entry)
	}

	resp := map[string]any{"tasks": tasks, "total": len(tasks)}
	data, _ := json.Marshal(resp)
	return string(data), nil
}

// RegisterMockOrchestrationTools registers all mock orchestration tools into a registry.
// Returns the state tracker for post-eval analysis.
func RegisterMockOrchestrationTools(registry *Registry, scenario string) *MockOrchestrationState {
	state := NewMockOrchestrationState(scenario)

	registry.Register(&MockDispatchTask{State: state})
	registry.Register(&MockGetTaskDetails{State: state})
	registry.Register(&MockCompleteTask{State: state})
	registry.Register(&MockUpdateTaskStatus{State: state})
	registry.Register(&MockRequestHumanInput{})
	registry.Register(&MockListTasks{State: state})

	return state
}

// MockOrchestrationTools returns mock orchestration tools as a Tool slice
// for injection into the tool pipeline before profile filtering.
func MockOrchestrationTools(scenario string) []Tool {
	state := NewMockOrchestrationState(scenario)
	return []Tool{
		&MockDispatchTask{State: state},
		&MockGetTaskDetails{State: state},
		&MockCompleteTask{State: state},
		&MockUpdateTaskStatus{State: state},
		&MockRequestHumanInput{},
		&MockListTasks{State: state},
	}
}
