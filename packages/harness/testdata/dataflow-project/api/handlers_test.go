package api

import (
	"testing"

	"dataflow/models"
	"dataflow/store"
)

func TestCreateTask(t *testing.T) {
	svc := NewService(store.NewTaskStore(), store.NewEventStore())
	id, err := svc.CreateTask("Fix bug", "Fix the login bug", "alice", 3, []string{"bug"})
	if err != nil {
		t.Fatalf("CreateTask failed: %v", err)
	}
	if id == "" {
		t.Fatal("expected non-empty task ID")
	}
}

func TestUpdateTaskStatus(t *testing.T) {
	svc := NewService(store.NewTaskStore(), store.NewEventStore())
	id, _ := svc.CreateTask("Task 1", "desc", "bob", 1, nil)

	// pending -> active
	if err := svc.UpdateTaskStatus(id, models.TaskStatusActive, "bob"); err != nil {
		t.Fatalf("UpdateTaskStatus pending->active failed: %v", err)
	}

	// active -> completed
	if err := svc.UpdateTaskStatus(id, models.TaskStatusCompleted, "bob"); err != nil {
		t.Fatalf("UpdateTaskStatus active->completed failed: %v", err)
	}

	// completed -> active should fail
	if err := svc.UpdateTaskStatus(id, models.TaskStatusActive, "bob"); err == nil {
		t.Fatal("expected error for completed->active transition")
	}
}

func TestGetTaskHistory(t *testing.T) {
	svc := NewService(store.NewTaskStore(), store.NewEventStore())
	id, _ := svc.CreateTask("History test", "desc", "carol", 2, nil)
	svc.UpdateTaskStatus(id, models.TaskStatusActive, "carol")
	svc.UpdateTaskStatus(id, models.TaskStatusCompleted, "carol")

	task, events, err := svc.GetTaskHistory(id)
	if err != nil {
		t.Fatalf("GetTaskHistory failed: %v", err)
	}
	if task.Status != models.TaskStatusCompleted {
		t.Errorf("expected status completed, got %s", task.Status)
	}
	// Should have 3 events: created, pending->active, active->completed
	if len(events) != 3 {
		t.Errorf("expected 3 events, got %d", len(events))
	}
}
