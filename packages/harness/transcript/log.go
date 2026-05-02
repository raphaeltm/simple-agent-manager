// Package transcript provides an append-only event log for agent sessions.
package transcript

import (
	"encoding/json"
	"sync"
	"time"
)

// EventType identifies the kind of transcript event.
type EventType string

const (
	EventLLMRequest  EventType = "llm_request"
	EventLLMResponse EventType = "llm_response"
	EventToolCall    EventType = "tool_call"
	EventToolResult  EventType = "tool_result"
	EventError       EventType = "error"
	EventInfo        EventType = "info"
)

// Event is a single entry in the transcript.
type Event struct {
	Type      EventType `json:"type"`
	Timestamp time.Time `json:"timestamp"`
	Turn      int       `json:"turn"`
	Data      any       `json:"data"`
}

// Log is a thread-safe append-only event log.
type Log struct {
	mu     sync.RWMutex
	events []Event
}

// NewLog creates an empty transcript log.
func NewLog() *Log {
	return &Log{}
}

// Append adds an event to the log.
func (l *Log) Append(eventType EventType, turn int, data any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events = append(l.events, Event{
		Type:      eventType,
		Timestamp: time.Now(),
		Turn:      turn,
		Data:      data,
	})
}

// Events returns a copy of all events.
func (l *Log) Events() []Event {
	l.mu.RLock()
	defer l.mu.RUnlock()
	out := make([]Event, len(l.events))
	copy(out, l.events)
	return out
}

// Len returns the number of events.
func (l *Log) Len() int {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return len(l.events)
}

// JSON serializes the log to JSON.
func (l *Log) JSON() ([]byte, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return json.MarshalIndent(l.events, "", "  ")
}
