package util

import (
	"fmt"
	"strings"

	"dataflow/models"
)

// ValidateTask checks that a task has all required fields.
func ValidateTask(t *models.Task) error {
	if strings.TrimSpace(t.Title) == "" {
		return fmt.Errorf("task title is required")
	}
	if t.Priority < 0 || t.Priority > 5 {
		return fmt.Errorf("priority must be between 0 and 5, got %d", t.Priority)
	}
	return nil
}

// ValidateTaskUpdate checks that an update is valid.
func ValidateTaskUpdate(u models.TaskUpdate) error {
	if u.Title != nil && strings.TrimSpace(*u.Title) == "" {
		return fmt.Errorf("title cannot be empty")
	}
	if u.Priority != nil && (*u.Priority < 0 || *u.Priority > 5) {
		return fmt.Errorf("priority must be between 0 and 5")
	}
	if u.Status != nil {
		switch *u.Status {
		case models.TaskStatusPending, models.TaskStatusActive,
			models.TaskStatusCompleted, models.TaskStatusCancelled:
			// valid
		default:
			return fmt.Errorf("invalid status: %s", *u.Status)
		}
	}
	return nil
}

// ValidateTransition checks that a status transition is allowed.
func ValidateTransition(from, to models.TaskStatus) error {
	allowed := map[models.TaskStatus][]models.TaskStatus{
		models.TaskStatusPending:   {models.TaskStatusActive, models.TaskStatusCancelled},
		models.TaskStatusActive:    {models.TaskStatusCompleted, models.TaskStatusCancelled},
		models.TaskStatusCompleted: {}, // terminal
		models.TaskStatusCancelled: {models.TaskStatusPending}, // can reopen
	}
	for _, valid := range allowed[from] {
		if valid == to {
			return nil
		}
	}
	return fmt.Errorf("transition from %s to %s is not allowed", from, to)
}
