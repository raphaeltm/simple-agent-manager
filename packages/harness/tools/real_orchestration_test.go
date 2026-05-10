package tools

import (
	"context"
	"testing"
)

func TestRealOrchestrationState_DispatchAndCheck(t *testing.T) {
	state := NewRealOrchestrationState()
	state.WorkDir = t.TempDir()

	// Use "echo" as a simple child process to verify spawning works.
	state.HarnessBin = "/bin/echo"

	dispatch := &RealDispatchTask{State: state}
	details := &RealGetTaskDetails{State: state}
	list := &RealListTasks{State: state}

	ctx := context.Background()

	// Dispatch a task.
	result, err := dispatch.Execute(ctx, map[string]any{
		"title":       "Test task",
		"description": "Do something simple",
	})
	if err != nil {
		t.Fatalf("dispatch failed: %v", err)
	}

	if result == "" {
		t.Fatal("expected non-empty result")
	}

	// The echo command should finish almost instantly.
	// Wait for the done channel.
	state.mu.Lock()
	task := state.tasks["task-001"]
	state.mu.Unlock()

	if task == nil {
		t.Fatal("task-001 not found in state")
	}

	// Wait for child process to finish.
	<-task.done

	// Check status via get_task_details.
	detailResult, err := details.Execute(ctx, map[string]any{"taskId": "task-001"})
	if err != nil {
		t.Fatalf("get_task_details failed: %v", err)
	}

	// echo exits 0, so status should be "completed".
	if task.Status != "completed" {
		t.Errorf("expected status 'completed', got %q (detail result: %s)", task.Status, detailResult)
	}

	// List tasks should show 1 task.
	listResult, err := list.Execute(ctx, nil)
	if err != nil {
		t.Fatalf("list_tasks failed: %v", err)
	}
	if listResult == "" {
		t.Fatal("expected non-empty list result")
	}
}

func TestRealOrchestrationState_FailedProcess(t *testing.T) {
	state := NewRealOrchestrationState()
	state.WorkDir = t.TempDir()

	// Use "false" as a child process that always fails.
	state.HarnessBin = "/bin/false"

	dispatch := &RealDispatchTask{State: state}
	ctx := context.Background()

	_, err := dispatch.Execute(ctx, map[string]any{
		"title":       "Failing task",
		"description": "This should fail",
	})
	if err != nil {
		t.Fatalf("dispatch failed: %v", err)
	}

	// Wait for child process to finish.
	state.mu.Lock()
	task := state.tasks["task-001"]
	state.mu.Unlock()

	<-task.done

	state.mu.Lock()
	defer state.mu.Unlock()

	if task.Status != "failed" {
		t.Errorf("expected status 'failed', got %q", task.Status)
	}
	if task.Error == "" {
		t.Error("expected non-empty error message for failed task")
	}
}

func TestRealDispatchTask_MissingTitle(t *testing.T) {
	state := NewRealOrchestrationState()
	dispatch := &RealDispatchTask{State: state}
	ctx := context.Background()

	_, err := dispatch.Execute(ctx, map[string]any{
		"description": "No title provided",
	})
	if err == nil {
		t.Fatal("expected error for missing title")
	}
}

func TestRealGetTaskDetails_NotFound(t *testing.T) {
	state := NewRealOrchestrationState()
	details := &RealGetTaskDetails{State: state}
	ctx := context.Background()

	_, err := details.Execute(ctx, map[string]any{"taskId": "nonexistent"})
	if err == nil {
		t.Fatal("expected error for nonexistent task")
	}
}

func TestRealOrchestrationTools_ReturnsAllTools(t *testing.T) {
	state := NewRealOrchestrationState()
	orchTools := RealOrchestrationTools(state)

	expected := map[string]bool{
		"dispatch_task":       false,
		"get_task_details":    false,
		"complete_task":       false,
		"update_task_status":  false,
		"request_human_input": false,
		"list_tasks":          false,
	}

	for _, tool := range orchTools {
		if _, ok := expected[tool.Name()]; !ok {
			t.Errorf("unexpected tool: %s", tool.Name())
		}
		expected[tool.Name()] = true
	}

	for name, found := range expected {
		if !found {
			t.Errorf("missing expected tool: %s", name)
		}
	}
}
