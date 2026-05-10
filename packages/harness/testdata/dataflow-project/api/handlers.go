package api

import (
	"fmt"
	"time"

	"dataflow/models"
	"dataflow/store"
	"dataflow/util"
)

// Service coordinates task operations between the store and validation layers.
type Service struct {
	tasks  *store.TaskStore
	events *store.EventStore
}

// NewService creates a new API service.
func NewService(tasks *store.TaskStore, events *store.EventStore) *Service {
	return &Service{tasks: tasks, events: events}
}

// CreateTask validates and creates a new task.
func (s *Service) CreateTask(title, description, assignedTo string, priority int, tags []string) (string, error) {
	t := &models.Task{
		Title:       title,
		Description: description,
		AssignedTo:  assignedTo,
		Priority:    priority,
		Tags:        tags,
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
	}
	if err := util.ValidateTask(t); err != nil {
		return "", fmt.Errorf("validation error: %w", err)
	}
	id, err := s.tasks.Create(t)
	if err != nil {
		return "", err
	}
	s.events.Record(&models.Event{
		TaskID:    id,
		Action:    "created",
		NewStatus: models.TaskStatusPending,
		Actor:     assignedTo,
		Timestamp: time.Now(),
	})
	return id, nil
}

// UpdateTaskStatus validates and updates a task's status with event recording.
func (s *Service) UpdateTaskStatus(taskID string, newStatus models.TaskStatus, actor string) error {
	task, err := s.tasks.Get(taskID)
	if err != nil {
		return err
	}
	if err := util.ValidateTransition(task.Status, newStatus); err != nil {
		return fmt.Errorf("invalid transition: %w", err)
	}
	oldStatus := task.Status
	update := models.TaskUpdate{Status: &newStatus}
	if err := util.ValidateTaskUpdate(update); err != nil {
		return fmt.Errorf("validation error: %w", err)
	}
	if err := s.tasks.Update(taskID, update); err != nil {
		return err
	}
	s.events.Record(&models.Event{
		TaskID:    taskID,
		Action:    "status_changed",
		OldStatus: oldStatus,
		NewStatus: newStatus,
		Actor:     actor,
		Timestamp: time.Now(),
	})
	return nil
}

// GetTaskHistory returns the task and its events.
func (s *Service) GetTaskHistory(taskID string) (*models.Task, []*models.Event, error) {
	task, err := s.tasks.Get(taskID)
	if err != nil {
		return nil, nil, err
	}
	events := s.events.ListByTask(taskID)
	return task, events, nil
}
