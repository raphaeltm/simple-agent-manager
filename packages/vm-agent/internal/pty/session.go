// Package pty provides PTY session management for terminal access.
package pty

import (
	"io"
	"log"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
)

// Session represents a PTY session.
type Session struct {
	ID         string
	UserID     string
	Name       string
	Cmd        *exec.Cmd
	Pty        *os.File
	Rows       int
	Cols       int
	CreatedAt  time.Time
	LastActive time.Time
	mu         sync.RWMutex
	onClose    func()

	// Persistence fields
	IsOrphaned     bool
	OrphanedAt     time.Time
	ProcessExited  bool
	ExitCode       int
	OutputBuffer   *RingBuffer
	orphanTimer    *time.Timer
	attachedWriter io.Writer
}

// SessionInfo is a lightweight struct for listing sessions without exposing internals.
type SessionInfo struct {
	ID               string
	Name             string
	Status           string // "running" or "exited"
	CreatedAt        time.Time
	LastActivityAt   time.Time
	WorkingDirectory string
}

// SetAttachedWriter sets the writer that receives live output (typically a WebSocket).
func (s *Session) SetAttachedWriter(w io.Writer) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.attachedWriter = w
}

// GetAttachedWriter returns the current attached writer.
func (s *Session) GetAttachedWriter() io.Writer {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.attachedWriter
}

// Info returns a SessionInfo snapshot of this session.
func (s *Session) Info() SessionInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()

	status := "running"
	if s.ProcessExited {
		status = "exited"
	}

	dir := ""
	if s.Cmd != nil {
		dir = s.Cmd.Dir
	}

	return SessionInfo{
		ID:               s.ID,
		Name:             s.Name,
		Status:           status,
		CreatedAt:        s.CreatedAt,
		LastActivityAt:   s.LastActive,
		WorkingDirectory: dir,
	}
}

// SessionConfig holds configuration for creating a new session.
type SessionConfig struct {
	ID               string
	UserID           string
	Name             string
	Shell            string
	Rows             int
	Cols             int
	Env              []string
	WorkDir          string
	OnClose          func()
	ContainerID      string // If set, exec into this Docker container
	ContainerUser    string // User to run as inside the container
	OutputBufferSize int    // Ring buffer capacity in bytes (0 = default)
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

	var cmd *exec.Cmd

	if cfg.ContainerID != "" {
		// Exec into the devcontainer via docker exec
		args := []string{"exec", "-it"}
		if cfg.ContainerUser != "" {
			args = append(args, "-u", cfg.ContainerUser)
		}
		if cfg.WorkDir != "" {
			args = append(args, "-w", cfg.WorkDir)
		}
		// Pass environment variables into the container
		for _, env := range cfg.Env {
			args = append(args, "-e", env)
		}
		args = append(args, "-e", "TERM=xterm-256color")
		args = append(args, cfg.ContainerID, shell, "-l")
		cmd = exec.Command("docker", args...)
	} else {
		// Direct host shell (fallback)
		cmd = exec.Command(shell)
		cmd.Env = append(os.Environ(), cfg.Env...)
		cmd.Env = append(cmd.Env, "TERM=xterm-256color")
		if cfg.WorkDir != "" {
			cmd.Dir = cfg.WorkDir
		}
	}

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
		ID:           cfg.ID,
		UserID:       cfg.UserID,
		Name:         cfg.Name,
		Cmd:          cmd,
		Pty:          ptmx,
		Rows:         rows,
		Cols:         cols,
		CreatedAt:    now,
		LastActive:   now,
		onClose:      cfg.OnClose,
		OutputBuffer: NewRingBuffer(cfg.OutputBufferSize),
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

// StartOutputReader starts a persistent goroutine that reads PTY output,
// always writes to the ring buffer, and conditionally writes to the attached writer.
// The onOutput callback is invoked on each chunk of output (e.g., to record activity).
// The onExit callback is invoked when the PTY read loop ends (process exited or error).
func (s *Session) StartOutputReader(onOutput func(sessionID string, data []byte), onExit func(sessionID string)) {
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := s.Pty.Read(buf)
			if n > 0 {
				s.updateLastActive()
				chunk := buf[:n]

				// Always write to the ring buffer
				s.OutputBuffer.Write(chunk)

				// Invoke the output callback (e.g., for idle detection, WebSocket forwarding)
				if onOutput != nil {
					onOutput(s.ID, chunk)
				}
			}
			if err != nil {
				// PTY read returned an error — process likely exited
				s.mu.Lock()
				s.ProcessExited = true
				if s.Cmd.ProcessState != nil {
					s.ExitCode = s.Cmd.ProcessState.ExitCode()
				}
				s.mu.Unlock()

				log.Printf("PTY output reader ended for session %s: %v", s.ID, err)

				if onExit != nil {
					onExit(s.ID)
				}
				return
			}
		}
	}()
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
