package logreader

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

var (
	// ErrStreamSend means the downstream client failed while receiving a log entry.
	ErrStreamSend = errors.New("log stream send failed")
	// ErrStreamScanner means stdout scanning failed, usually due to I/O failure or an oversized line.
	ErrStreamScanner = errors.New("log stream scanner failed")
	// ErrFollowProcessExit means journalctl failed before the stream context was cancelled.
	ErrFollowProcessExit = errors.New("log follow process failed")
	// ErrFollowCleanExit means journalctl exited cleanly while the stream context was still live.
	ErrFollowCleanExit = errors.New("log follow process exited")
)

const (
	defaultStreamBufferSize = 100
	defaultFollowDelay      = 2 * time.Second
)

// StreamBufferSize is the number of recent entries sent as catch-up on connection.
var StreamBufferSize = envPositiveInt("LOG_STREAM_BUFFER_SIZE", defaultStreamBufferSize)

// FollowRestartDelay is the delay before restarting journalctl after process exits.
var FollowRestartDelay = envPositiveDuration("LOG_STREAM_RESTART_DELAY", defaultFollowDelay)

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
		if err == nil {
			err = ErrFollowCleanExit
		}
		if errors.Is(err, ErrStreamSend) || errors.Is(err, ErrStreamScanner) {
			return err
		}

		slog.Warn("journalctl --follow exited, restarting", "error", err)
		delay := FollowRestartDelay
		if delay <= 0 {
			delay = defaultFollowDelay
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
			// Retry journalctl after a bounded pause.
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

	var primaryErr error
	scanner := bufio.NewScanner(stdout)
	// Increase scanner buffer for long log lines
	scanner.Buffer(make([]byte, 0, 64*1024), 256*1024)

	for scanner.Scan() {
		if ctx.Err() != nil {
			primaryErr = ctx.Err()
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
			primaryErr = fmt.Errorf("%w: %w", ErrStreamSend, err)
			break
		}
	}

	if primaryErr == nil {
		if err := scanner.Err(); err != nil {
			primaryErr = fmt.Errorf("%w: %w", ErrStreamScanner, err)
		} else if ctx.Err() != nil {
			primaryErr = ctx.Err()
		}
	}

	if primaryErr != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	waitErr := cmd.Wait()
	if primaryErr != nil {
		return primaryErr
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if waitErr != nil {
		return fmt.Errorf("%w: %w", ErrFollowProcessExit, waitErr)
	}
	return ErrFollowCleanExit
}

// buildFollowArgs constructs journalctl --follow arguments.
// For Source=all, follow mode streams unrestricted journald only. It derives
// agent/systemd/docker sources from journald fields but does not follow
// cloud-init files; ReadLogs performs that multi-source merge for snapshots.
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
	default: // "all" streams unrestricted journald only.
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
		Source: defaultJournalSource(filterSource),
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

func defaultJournalSource(filterSource string) string {
	switch filterSource {
	case "agent":
		return "agent"
	case "docker":
		return "docker"
	default:
		return "systemd"
	}
}

// StreamCommand creates an exec.Cmd for the given context (used internally).
// Exported for testing only.
func StreamCommand(ctx context.Context, name string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, name, args...)
}

func envPositiveDuration(key string, defaultVal time.Duration) time.Duration {
	if defaultVal <= 0 {
		defaultVal = time.Second
	}
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return defaultVal
}
