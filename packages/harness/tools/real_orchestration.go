// Package tools provides real orchestration tools that spawn harness child sessions.
// When dispatch_task is called, a real harness subprocess runs the subtask using
// the worker model and workspace tool profile.
package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"sync"
)

// RealOrchestrationState tracks real child harness processes.
type RealOrchestrationState struct {
	mu      sync.Mutex
	tasks   map[string]*realTask
	taskSeq int

	// Config for spawning child sessions.
	HarnessBin string // path to harness binary (defaults to os.Args[0])
	WorkDir    string // working directory for child sessions
	Model      string // model for child sessions
	APIURL     string // API URL for child sessions
	APIKey     string // API key for child sessions
	AuthHeader string // custom auth header for child sessions
}

type realTask struct {
	ID          string
	Title       string
	Description string
	Status      string // dispatched, in_progress, completed, failed
	Output      string
	Error       string
	cmd         *exec.Cmd
	stdout      *bytes.Buffer
	stderr      *bytes.Buffer
	done        chan struct{} // closed when process exits
	exitErr     error
}

// NewRealOrchestrationState creates a new real orchestration state tracker.
func NewRealOrchestrationState() *RealOrchestrationState {
	return &RealOrchestrationState{
		tasks: make(map[string]*realTask),
	}
}

// RealDispatchTask spawns a real harness child session for each subtask.
type RealDispatchTask struct {
	State *RealOrchestrationState
}

func (t *RealDispatchTask) Name() string { return "dispatch_task" }
func (t *RealDispatchTask) Description() string {
	return "Dispatch a subtask to a child agent for execution. The child runs as a real harness session with the worker model."
}
func (t *RealDispatchTask) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"title":       map[string]any{"type": "string", "description": "Short title for the subtask"},
			"description": map[string]any{"type": "string", "description": "Detailed description with context, file paths, and acceptance criteria"},
		},
		"required": []any{"title", "description"},
	}
}

func (t *RealDispatchTask) Execute(ctx context.Context, params map[string]any) (string, error) {
	title, _ := params["title"].(string)
	desc, _ := params["description"].(string)

	if title == "" {
		return "", fmt.Errorf("title is required")
	}
	if desc == "" {
		return "", fmt.Errorf("description is required")
	}

	t.State.mu.Lock()
	t.State.taskSeq++
	id := fmt.Sprintf("task-%03d", t.State.taskSeq)

	harnessBin := t.State.HarnessBin
	if harnessBin == "" {
		harnessBin, _ = os.Executable()
	}

	// Build child harness command.
	args := []string{
		"--dir", t.State.WorkDir,
		"--prompt", desc,
		"--prompt-preset", "workspace",
		"--tool-profile", "workspace",
		"--max-turns", "15",
		"--repo-map=true",
	}

	if t.State.APIURL != "" {
		args = append(args, "--provider", "openai")
		args = append(args, "--api-url", t.State.APIURL)
		args = append(args, "--model", t.State.Model)
		if t.State.APIKey != "" {
			args = append(args, "--api-key", t.State.APIKey)
		}
		if t.State.AuthHeader != "" {
			args = append(args, "--auth-header", t.State.AuthHeader)
		}
	} else {
		args = append(args, "--provider", "mock")
	}

	cmd := exec.CommandContext(ctx, harnessBin, args...)
	cmd.Dir = t.State.WorkDir

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	task := &realTask{
		ID:          id,
		Title:       title,
		Description: desc,
		Status:      "dispatched",
		cmd:         cmd,
		stdout:      &stdout,
		stderr:      &stderr,
		done:        make(chan struct{}),
	}
	t.State.tasks[id] = task
	t.State.mu.Unlock()

	// Start the child process in the background.
	if err := cmd.Start(); err != nil {
		t.State.mu.Lock()
		task.Status = "failed"
		task.Error = fmt.Sprintf("failed to start child process: %v", err)
		close(task.done)
		t.State.mu.Unlock()

		resp := map[string]any{
			"taskId": id,
			"status": "failed",
			"error":  task.Error,
		}
		data, _ := json.Marshal(resp)
		return string(data), nil
	}

	// Update status to in_progress.
	t.State.mu.Lock()
	task.Status = "in_progress"
	t.State.mu.Unlock()

	// Monitor the child process in a goroutine.
	go func() {
		defer close(task.done)
		err := cmd.Wait()

		t.State.mu.Lock()
		defer t.State.mu.Unlock()

		if err != nil {
			task.Status = "failed"
			task.exitErr = err
			task.Error = fmt.Sprintf("child process failed: %v\nstderr: %s",
				err, truncateStr(stderr.String(), 500))
			task.Output = truncateStr(stdout.String(), 1000)
		} else {
			task.Status = "completed"
			task.Output = truncateStr(stdout.String(), 1000)
		}
	}()

	resp := map[string]any{
		"taskId": id,
		"status": "in_progress",
		"title":  title,
	}
	data, _ := json.Marshal(resp)
	return string(data), nil
}

// RealGetTaskDetails reports real status from child processes.
type RealGetTaskDetails struct {
	State *RealOrchestrationState
}

func (t *RealGetTaskDetails) Name() string { return "get_task_details" }
func (t *RealGetTaskDetails) Description() string {
	return "Get the current status and details of a dispatched subtask by its task ID."
}
func (t *RealGetTaskDetails) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"taskId": map[string]any{"type": "string", "description": "The task ID returned from dispatch_task"},
		},
		"required": []any{"taskId"},
	}
}

func (t *RealGetTaskDetails) Execute(_ context.Context, params map[string]any) (string, error) {
	taskID, _ := params["taskId"].(string)
	if taskID == "" {
		return "", fmt.Errorf("taskId is required")
	}

	t.State.mu.Lock()
	task, ok := t.State.tasks[taskID]
	t.State.mu.Unlock()

	if !ok {
		return "", fmt.Errorf("task not found: %s", taskID)
	}

	// Check if process has finished (non-blocking).
	select {
	case <-task.done:
		// Process finished — status already updated by goroutine.
	default:
		// Still running.
	}

	t.State.mu.Lock()
	defer t.State.mu.Unlock()

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

// RealListTasks lists all real child tasks.
type RealListTasks struct {
	State *RealOrchestrationState
}

func (t *RealListTasks) Name() string        { return "list_tasks" }
func (t *RealListTasks) Description() string { return "List all dispatched subtasks with their current status." }
func (t *RealListTasks) Schema() map[string]any {
	return map[string]any{
		"type":       "object",
		"properties": map[string]any{},
	}
}

func (t *RealListTasks) Execute(_ context.Context, _ map[string]any) (string, error) {
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

// RealOrchestrationTools returns real orchestration tools as a Tool slice.
// Uses the mock implementations for complete_task, update_task_status, and
// request_human_input since those are purely informational.
func RealOrchestrationTools(state *RealOrchestrationState) []Tool {
	mockState := NewMockOrchestrationState("success")
	return []Tool{
		&RealDispatchTask{State: state},
		&RealGetTaskDetails{State: state},
		&MockCompleteTask{State: mockState},
		&MockUpdateTaskStatus{State: mockState},
		&MockRequestHumanInput{},
		&RealListTasks{State: state},
	}
}

func truncateStr(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "...(truncated)"
}
