// Package pty provides PTY session management for terminal access.
package pty

import (
	"io"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
)

// Session represents a PTY session.
type Session struct {
	ID          string
	UserID      string
	Cmd         *exec.Cmd
	Pty         *os.File
	Rows        int
	Cols        int
	CreatedAt   time.Time
	LastActive  time.Time
	mu          sync.RWMutex
	onClose     func()
}

// SessionConfig holds configuration for creating a new session.
type SessionConfig struct {
	ID       string
	UserID   string
	Shell    string
	Rows     int
	Cols     int
	Env      []string
	WorkDir  string
	OnClose  func()
}

// NewSession creates a new PTY session.
func NewSession(cfg SessionConfig) (*Session, error) {
	shell := cfg.Shell
	if shell == "" {
		shell = "/bin/bash"
	}

	rows := cfg.Rows
	if rows <= 0 {
		rows = 24
	}

	cols := cfg.Cols
	if cols <= 0 {
		cols = 80
	}

	cmd := exec.Command(shell)
	cmd.Env = append(os.Environ(), cfg.Env...)
	if cfg.WorkDir != "" {
		cmd.Dir = cfg.WorkDir
	}

	// Set TERM for proper terminal handling
	cmd.Env = append(cmd.Env, "TERM=xterm-256color")

	// Start PTY
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{
		Rows: uint16(rows),
		Cols: uint16(cols),
	})
	if err != nil {
		return nil, err
	}

	now := time.Now()
	session := &Session{
		ID:         cfg.ID,
		UserID:     cfg.UserID,
		Cmd:        cmd,
		Pty:        ptmx,
		Rows:       rows,
		Cols:       cols,
		CreatedAt:  now,
		LastActive: now,
		onClose:    cfg.OnClose,
	}

	return session, nil
}

// Read reads from the PTY.
func (s *Session) Read(p []byte) (n int, err error) {
	s.updateLastActive()
	return s.Pty.Read(p)
}

// Write writes to the PTY.
func (s *Session) Write(p []byte) (n int, err error) {
	s.updateLastActive()
	return s.Pty.Write(p)
}

// Resize resizes the PTY window.
func (s *Session) Resize(rows, cols int) error {
	s.mu.Lock()
	s.Rows = rows
	s.Cols = cols
	s.mu.Unlock()

	return pty.Setsize(s.Pty, &pty.Winsize{
		Rows: uint16(rows),
		Cols: uint16(cols),
	})
}

// Close closes the PTY session.
func (s *Session) Close() error {
	if s.onClose != nil {
		s.onClose()
	}

	// Close PTY
	if err := s.Pty.Close(); err != nil && err != io.EOF {
		return err
	}

	// Kill process if still running
	if s.Cmd.Process != nil {
		_ = s.Cmd.Process.Kill()
		_, _ = s.Cmd.Process.Wait()
	}

	return nil
}

// IsRunning checks if the underlying process is still running.
func (s *Session) IsRunning() bool {
	if s.Cmd.Process == nil {
		return false
	}
	// Try to get process state without blocking
	return s.Cmd.ProcessState == nil
}

// updateLastActive updates the last active timestamp.
func (s *Session) updateLastActive() {
	s.mu.Lock()
	s.LastActive = time.Now()
	s.mu.Unlock()
}

// GetLastActive returns the last active timestamp.
func (s *Session) GetLastActive() time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.LastActive
}

// IdleTime returns how long the session has been idle.
func (s *Session) IdleTime() time.Duration {
	return time.Since(s.GetLastActive())
}
