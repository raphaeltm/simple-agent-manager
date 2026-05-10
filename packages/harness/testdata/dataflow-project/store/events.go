package store

import (
	"fmt"
	"sync"

	"dataflow/models"
)

// EventStore provides in-memory persistence for events.
type EventStore struct {
	mu     sync.RWMutex
	events []*models.Event
	seq    int
}

// NewEventStore creates an empty event store.
func NewEventStore() *EventStore {
	return &EventStore{}
}

// Record adds a new event.
func (s *EventStore) Record(e *models.Event) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seq++
	e.ID = fmt.Sprintf("EVT-%d", s.seq)
	s.events = append(s.events, e)
	return e.ID, nil
}

// ListByTask returns all events for a given task ID.
func (s *EventStore) ListByTask(taskID string) []*models.Event {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var result []*models.Event
	for _, e := range s.events {
		if e.TaskID == taskID {
			result = append(result, e)
		}
	}
	return result
}

// List returns events matching the filter.
func (s *EventStore) List(f models.EventFilter) []*models.Event {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var result []*models.Event
	for _, e := range s.events {
		if f.TaskID != nil && e.TaskID != *f.TaskID {
			continue
		}
		if f.Actor != nil && e.Actor != *f.Actor {
			continue
		}
		if f.Action != nil && e.Action != *f.Action {
			continue
		}
		result = append(result, e)
	}
	return result
}
