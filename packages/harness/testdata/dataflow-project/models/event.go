package models

import "time"

// Event records a state change on a task.
type Event struct {
	ID        string
	TaskID    string
	Action    string
	OldStatus TaskStatus
	NewStatus TaskStatus
	Actor     string
	Timestamp time.Time
	Metadata  map[string]string
}

// EventFilter is used to query events.
type EventFilter struct {
	TaskID *string
	Actor  *string
	Action *string
}
