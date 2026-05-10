package store

import (
	"fmt"
	"sync"

	"dataflow/models"
)

// TaskStore provides in-memory persistence for tasks.
type TaskStore struct {
	mu    sync.RWMutex
	tasks map[string]*models.Task
	seq   int
}

// NewTaskStore creates an empty task store.
func NewTaskStore() *TaskStore {
	return &TaskStore{tasks: make(map[string]*models.Task)}
}

// Create adds a new task and returns its ID.
func (s *TaskStore) Create(t *models.Task) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seq++
	t.ID = fmt.Sprintf("TASK-%d", s.seq)
	t.Status = models.TaskStatusPending
	s.tasks[t.ID] = t
	return t.ID, nil
}

// Get retrieves a task by ID.
func (s *TaskStore) Get(id string) (*models.Task, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	t, ok := s.tasks[id]
	if !ok {
		return nil, fmt.Errorf("task %s not found", id)
	}
	return t, nil
}

// List returns all tasks matching the given filter.
func (s *TaskStore) List(f models.TaskFilter) []*models.Task {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var result []*models.Task
	for _, t := range s.tasks {
		if f.Status != nil && t.Status != *f.Status {
			continue
		}
		if f.AssignedTo != nil && t.AssignedTo != *f.AssignedTo {
			continue
		}
		if f.Priority != nil && t.Priority != *f.Priority {
			continue
		}
		result = append(result, t)
	}
	return result
}

// Update modifies a task with the given changes.
func (s *TaskStore) Update(id string, u models.TaskUpdate) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tasks[id]
	if !ok {
		return fmt.Errorf("task %s not found", id)
	}
	if u.Title != nil {
		t.Title = *u.Title
	}
	if u.Description != nil {
		t.Description = *u.Description
	}
	if u.AssignedTo != nil {
		t.AssignedTo = *u.AssignedTo
	}
	if u.Status != nil {
		t.Status = *u.Status
	}
	if u.Priority != nil {
		t.Priority = *u.Priority
	}
	if u.Tags != nil {
		t.Tags = u.Tags
	}
	return nil
}

// Delete removes a task by ID.
func (s *TaskStore) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.tasks[id]; !ok {
		return fmt.Errorf("task %s not found", id)
	}
	delete(s.tasks, id)
	return nil
}
