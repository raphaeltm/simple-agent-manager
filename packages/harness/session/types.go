// Package session provides SQLite-backed session persistence for the agent harness.
package session

import "time"

// Session represents a persisted agent session.
type Session struct {
	ID           string
	CreatedAt    time.Time
	UpdatedAt    time.Time
	SystemPrompt string
	Status       string // active, completed, abandoned
	WorkDir      string
	Model        string
	TotalTurns   int
}

// Config holds parameters for creating a new session.
type Config struct {
	SystemPrompt string
	WorkDir      string
	Model        string
}

// Summary is a lightweight view of a session for listing.
type Summary struct {
	ID         string
	CreatedAt  time.Time
	Status     string
	TotalTurns int
}
