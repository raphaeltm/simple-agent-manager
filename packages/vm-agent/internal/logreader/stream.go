package logreader

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// StreamBufferSize is the number of recent entries sent as catch-up on connection.
var StreamBufferSize = envInt("LOG_STREAM_BUFFER_SIZE", 100)

// SendFunc is called for each log entry during streaming.
type SendFunc func(entry LogEntry) error

// StreamLogs starts real-time log streaming using journalctl --follow.
// It first sends recent catch-up entries, then streams new entries as they arrive.
// The function blocks until the context is cancelled or an error occurs.
func (r *Reader) StreamLogs(ctx context.Context, filter LogFilter, send SendFunc) error {
	// Phase 1: Catch-up — send recent entries
	catchUpCount, err := r.sendCatchUp(ctx, filter, send)
	if err != nil {
		return fmt.Errorf("catch-up: %w", err)
	}
	slog.Debug("Log stream catch-up complete", "count", catchUpCount)

	// Phase 2: Stream — follow new entries
	return r.followLogs(ctx, filter, send)
}

// sendCatchUp sends the most recent StreamBufferSize entries matching the filter.
func (r *Reader) sendCatchUp(ctx context.Context, filter LogFilter, send SendFunc) (int, error) {
	catchUpFilter := filter
	catchUpFilter.Limit = StreamBufferSize
	catchUpFilter.Cursor = ""

	resp, err := r.ReadLogs(ctx, catchUpFilter)
	if err != nil {
		return 0, err
	}

	// ReadLogs returns newest-first; send oldest-first for catch-up
	for i := len(resp.Entries) - 1; i >= 0; i-- {
		if err := send(resp.Entries[i]); err != nil {
			return len(resp.Entries) - 1 - i, err
		}
	}

	return len(resp.Entries), nil
}

// followLogs starts a journalctl --follow process and streams entries.
func (r *Reader) followLogs(ctx context.Context, filter LogFilter, send SendFunc) error {
	for {
		err := r.runFollowProcess(ctx, filter, send)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			slog.Warn("journalctl --follow exited, restarting", "error", err)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(2 * time.Second):
				// Retry after brief pause
			}
		}
	}
}

// runFollowProcess runs a single journalctl --follow subprocess.
func (r *Reader) runFollowProcess(ctx context.Context, filter LogFilter, send SendFunc) error {
	args := buildFollowArgs(filter)

	cmd := r.exec(ctx, "journalctl", args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start journalctl: %w", err)
	}

	scanner := bufio.NewScanner(stdout)
	// Increase scanner buffer for long log lines
	scanner.Buffer(make([]byte, 0, 64*1024), 256*1024)

	for scanner.Scan() {
		if ctx.Err() != nil {
			break
		}

		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}

		var raw map[string]interface{}
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			continue
		}

		entry := journalEntryToLogEntry(raw, filter.Source)
		if entry == nil {
			continue
		}

		// Apply level filter
		if filter.Level != "" && filter.Level != "debug" {
			minOrd := levelOrder[strings.ToLower(filter.Level)]
			if levelOrder[entry.Level] < minOrd {
				continue
			}
		}

		// Apply search filter
		if filter.Search != "" {
			if !strings.Contains(strings.ToLower(entry.Message), strings.ToLower(filter.Search)) {
				continue
			}
		}

		if err := send(*entry); err != nil {
			break
		}
	}

	// Kill process if still running
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	return cmd.Wait()
}

// buildFollowArgs constructs journalctl --follow arguments.
func buildFollowArgs(filter LogFilter) []string {
	args := []string{
		"--follow",
		"--output=json",
		"--no-pager",
		"-n", "0", // Don't replay history (catch-up already done)
	}

	switch filter.Source {
	case "agent", "systemd":
		args = append(args, "-u", "vm-agent.service")
	case "docker":
		args = append(args, "_TRANSPORT=journal")
		if filter.Container != "" {
			args = append(args, fmt.Sprintf("CONTAINER_NAME=%s", filter.Container))
		} else {
			args = append(args, "CONTAINER_NAME")
		}
	default: // "all" — don't restrict to a specific unit
	}

	if filter.Level != "" {
		args = append(args, "-p", journalPriority(filter.Level))
	}

	return args
}

// journalEntryToLogEntry converts a raw journald JSON entry to a LogEntry.
func journalEntryToLogEntry(raw map[string]interface{}, filterSource string) *LogEntry {
	entry := &LogEntry{
		Level:  "info",
		Source: "agent",
	}

	// Parse timestamp from __REALTIME_TIMESTAMP (microseconds since epoch)
	if ts, ok := raw["__REALTIME_TIMESTAMP"].(string); ok {
		if usec, err := strconv.ParseInt(ts, 10, 64); err == nil {
			t := time.UnixMicro(usec)
			entry.Timestamp = t.UTC().Format(time.RFC3339Nano)
		}
	}

	// Parse message
	if msg, ok := raw["MESSAGE"].(string); ok {
		entry.Message = msg
	}
	if entry.Message == "" {
		return nil
	}

	// Parse priority
	if pri, ok := raw["PRIORITY"].(string); ok {
		entry.Level = priorityToLevel(pri)
	}

	// Determine source
	if containerName, ok := raw["CONTAINER_NAME"].(string); ok && containerName != "" {
		entry.Source = "docker:" + containerName
	} else if unit, ok := raw["_SYSTEMD_UNIT"].(string); ok {
		if unit == "vm-agent.service" {
			entry.Source = "agent"
		} else {
			entry.Source = "systemd"
		}
	}

	return entry
}

// StreamCommand creates an exec.Cmd for the given context (used internally).
// Exported for testing only.
func StreamCommand(ctx context.Context, name string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, name, args...)
}

func init() {
	// Allow overriding buffer size from env
	if v := os.Getenv("LOG_STREAM_BUFFER_SIZE"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			StreamBufferSize = n
		}
	}
}
