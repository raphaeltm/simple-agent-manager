package models

import "time"

// Task represents a work item in the system.
type Task struct {
	ID          string
	Title       string
	Description string
	AssignedTo  string
	Status      TaskStatus
	Priority    int
	CreatedAt   time.Time
	UpdatedAt   time.Time
	Tags        []string
}

// TaskStatus represents the lifecycle state of a task.
type TaskStatus string

const (
	TaskStatusPending    TaskStatus = "pending"
	TaskStatusActive     TaskStatus = "active"
	TaskStatusCompleted  TaskStatus = "completed"
	TaskStatusCancelled  TaskStatus = "cancelled"
)

// TaskFilter is used to query tasks with specific criteria.
type TaskFilter struct {
	Status     *TaskStatus
	AssignedTo *string
	Priority   *int
	Tags       []string
}

// TaskUpdate contains the mutable fields of a task.
type TaskUpdate struct {
	Title       *string
	Description *string
	AssignedTo  *string
	Status      *TaskStatus
	Priority    *int
	Tags        []string
}
