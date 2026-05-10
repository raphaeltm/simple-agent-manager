// Package session provides SQLite-backed persistence for agent conversation sessions.
package session

import "time"

// Status represents the lifecycle state of a session.
type Status string

const (
	StatusActive    Status = "active"
	StatusCompleted Status = "completed"
	StatusError     Status = "error"
	StatusAbandoned Status = "abandoned"
)

// Session represents a persisted agent conversation session.
type Session struct {
	ID        string       `json:"id"`
	CreatedAt time.Time    `json:"created_at"`
	UpdatedAt time.Time    `json:"updated_at"`
	Status    Status       `json:"status"`
	Config    SessionConfig `json:"config"`
}

// SessionConfig captures the configuration used to create a session.
type SessionConfig struct {
	SystemPrompt string `json:"system_prompt,omitempty"`
	Model        string `json:"model,omitempty"`
	Provider     string `json:"provider,omitempty"`
	WorkDir      string `json:"work_dir,omitempty"`
	MaxTurns     int    `json:"max_turns,omitempty"`
	UserPrompt   string `json:"user_prompt,omitempty"`
}

// SessionSummary is a lightweight view used by ListSessions.
type SessionSummary struct {
	ID           string    `json:"id"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
	Status       Status    `json:"status"`
	MessageCount int       `json:"message_count"`
	UserPrompt   string    `json:"user_prompt,omitempty"`
}
