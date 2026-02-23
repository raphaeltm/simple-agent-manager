// Package logreader provides unified log reading from journald, cloud-init files,
// and Docker container logs on the node.
package logreader

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// LogEntry represents a unified log entry from any source.
type LogEntry struct {
	Timestamp string         `json:"timestamp"`
	Level     string         `json:"level"`
	Source    string         `json:"source"`
	Message   string         `json:"message"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

// LogFilter represents query parameters for log retrieval.
type LogFilter struct {
	Source    string // "all", "agent", "cloud-init", "docker", "systemd"
	Level     string // "debug", "info", "warn", "error"
	Container string // Docker container name filter
	Since     string // ISO 8601 or relative (e.g., "-1h")
	Until     string // ISO 8601
	Search    string // Substring match in message
	Cursor    string // Pagination cursor (journald cursor)
	Limit     int    // Max entries (default 200, max 1000)
}

// LogResponse is the HTTP response for log retrieval.
type LogResponse struct {
	Entries    []LogEntry `json:"entries"`
	NextCursor *string    `json:"nextCursor"`
	HasMore    bool       `json:"hasMore"`
}

// DefaultLimit is the default number of log entries per page.
var DefaultLimit = envInt("LOG_RETRIEVAL_DEFAULT_LIMIT", 200)

// MaxLimit is the maximum number of log entries per page.
var MaxLimit = envInt("LOG_RETRIEVAL_MAX_LIMIT", 1000)

// CommandExecutor abstracts exec.Command for testing.
type CommandExecutor func(ctx context.Context, name string, args ...string) *exec.Cmd

// Reader reads logs from various sources on the node.
type Reader struct {
	exec    CommandExecutor
	timeout time.Duration
}

// DefaultLogReaderTimeout is the default timeout for journalctl read operations.
var DefaultLogReaderTimeout = envDuration("LOG_READER_TIMEOUT", 30*time.Second)

// NewReader creates a new log reader with the default command executor.
func NewReader() *Reader {
	return &Reader{
		exec:    defaultExec,
		timeout: DefaultLogReaderTimeout,
	}
}

// NewReaderWithTimeout creates a new log reader with a custom timeout.
func NewReaderWithTimeout(timeout time.Duration) *Reader {
	return &Reader{
		exec:    defaultExec,
		timeout: timeout,
	}
}

// NewReaderWithExecutor creates a Reader with a custom command executor (for testing).
func NewReaderWithExecutor(executor CommandExecutor) *Reader {
	return &Reader{
		exec:    executor,
		timeout: DefaultLogReaderTimeout,
	}
}

func envDuration(key string, defaultVal time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return defaultVal
}

func defaultExec(ctx context.Context, name string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, name, args...)
}

// ReadLogs retrieves log entries matching the given filter.
func (r *Reader) ReadLogs(ctx context.Context, filter LogFilter) (*LogResponse, error) {
	limit := clampLimit(filter.Limit)

	var entries []LogEntry
	var nextCursor *string

	switch filter.Source {
	case "cloud-init":
		cloudEntries, err := r.readCloudInitLogs(filter)
		if err != nil {
			slog.Warn("Failed to read cloud-init logs", "error", err)
		}
		entries = cloudEntries

	case "agent", "systemd":
		journalEntries, cursor, err := r.readJournalLogs(ctx, filter, limit+1)
		if err != nil {
			return nil, fmt.Errorf("read journal logs: %w", err)
		}
		entries = journalEntries
		nextCursor = cursor

	case "docker":
		journalEntries, cursor, err := r.readDockerLogs(ctx, filter, limit+1)
		if err != nil {
			return nil, fmt.Errorf("read docker logs: %w", err)
		}
		entries = journalEntries
		nextCursor = cursor

	default: // "all"
		// Read from all sources and merge
		var allEntries []LogEntry

		journalEntries, cursor, err := r.readJournalLogs(ctx, filter, limit+1)
		if err != nil {
			slog.Warn("Failed to read journal logs", "error", err)
		} else {
			allEntries = append(allEntries, journalEntries...)
			nextCursor = cursor
		}

		dockerEntries, _, err := r.readDockerLogs(ctx, filter, limit+1)
		if err != nil {
			slog.Warn("Failed to read docker logs", "error", err)
		} else {
			allEntries = append(allEntries, dockerEntries...)
		}

		cloudEntries, err := r.readCloudInitLogs(filter)
		if err != nil {
			slog.Warn("Failed to read cloud-init logs", "error", err)
		} else {
			allEntries = append(allEntries, cloudEntries...)
		}

		// Sort by timestamp descending (newest first)
		sort.Slice(allEntries, func(i, j int) bool {
			return allEntries[i].Timestamp > allEntries[j].Timestamp
		})

		entries = allEntries
	}

	// Apply search filter (case-insensitive substring match)
	if filter.Search != "" {
		entries = filterBySearch(entries, filter.Search)
	}

	// Apply level filter
	if filter.Level != "" && filter.Level != "debug" {
		entries = filterByLevel(entries, filter.Level)
	}

	// Paginate
	hasMore := len(entries) > limit
	if hasMore {
		entries = entries[:limit]
	}

	return &LogResponse{
		Entries:    entries,
		NextCursor: nextCursor,
		HasMore:    hasMore,
	}, nil
}

// readJournalLogs reads from journald for agent/systemd sources.
func (r *Reader) readJournalLogs(ctx context.Context, filter LogFilter, limit int) ([]LogEntry, *string, error) {
	ctx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()

	args := []string{
		"--output=json",
		"--no-pager",
		"-u", "vm-agent.service",
		"-n", strconv.Itoa(limit),
		"--reverse",
	}

	if filter.Since != "" {
		args = append(args, "--since", normalizeTimeArg(filter.Since))
	}
	if filter.Until != "" {
		args = append(args, "--until", normalizeTimeArg(filter.Until))
	}
	if filter.Cursor != "" {
		args = append(args, "--after-cursor", filter.Cursor)
	}
	if filter.Level != "" {
		args = append(args, "-p", journalPriority(filter.Level))
	}

	cmd := r.exec(ctx, "journalctl", args...)
	out, err := cmd.Output()
	if err != nil {
		return nil, nil, fmt.Errorf("journalctl: %w", err)
	}

	entries, lastCursor := parseJournalJSON(string(out), "agent")
	return entries, lastCursor, nil
}

// readDockerLogs reads Docker container logs from journald.
func (r *Reader) readDockerLogs(ctx context.Context, filter LogFilter, limit int) ([]LogEntry, *string, error) {
	ctx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()

	args := []string{
		"--output=json",
		"--no-pager",
		"-n", strconv.Itoa(limit),
		"--reverse",
		// Filter to Docker container entries
		"_TRANSPORT=journal",
	}

	if filter.Container != "" {
		args = append(args, fmt.Sprintf("CONTAINER_NAME=%s", filter.Container))
	} else {
		// Match any entry that has CONTAINER_NAME set (Docker journald driver)
		args = append(args, "CONTAINER_NAME")
	}

	if filter.Since != "" {
		args = append(args, "--since", normalizeTimeArg(filter.Since))
	}
	if filter.Until != "" {
		args = append(args, "--until", normalizeTimeArg(filter.Until))
	}
	if filter.Cursor != "" {
		args = append(args, "--after-cursor", filter.Cursor)
	}

	cmd := r.exec(ctx, "journalctl", args...)
	out, err := cmd.Output()
	if err != nil {
		// Docker logs via journald may not be available if Docker isn't using journald driver
		return nil, nil, nil
	}

	entries, lastCursor := parseJournalJSON(string(out), "docker")
	return entries, lastCursor, nil
}

// cloudInitTimestamp matches timestamps like "2026-02-23 15:30:00,123"
var cloudInitTimestamp = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2},?\d*)`)

// cloudInitLevel matches log levels like " - DEBUG - " or " - WARNING - "
var cloudInitLevel = regexp.MustCompile(`\s-\s(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s-\s`)

// readCloudInitLogs reads from cloud-init log files.
func (r *Reader) readCloudInitLogs(filter LogFilter) ([]LogEntry, error) {
	var entries []LogEntry

	// Read structured cloud-init.log
	logEntries, err := parseCloudInitLog("/var/log/cloud-init.log")
	if err != nil {
		slog.Debug("cloud-init.log not available", "error", err)
	} else {
		entries = append(entries, logEntries...)
	}

	// Read raw cloud-init-output.log
	outputEntries, err := parseCloudInitOutput("/var/log/cloud-init-output.log")
	if err != nil {
		slog.Debug("cloud-init-output.log not available", "error", err)
	} else {
		entries = append(entries, outputEntries...)
	}

	// Filter by time range if specified
	if filter.Since != "" || filter.Until != "" {
		entries = filterByTimeRange(entries, filter.Since, filter.Until)
	}

	// Sort newest first
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Timestamp > entries[j].Timestamp
	})

	return entries, nil
}

func parseCloudInitLog(path string) ([]LogEntry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var entries []LogEntry
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}

		entry := LogEntry{
			Source: "cloud-init",
			Level:  "info",
		}

		// Extract timestamp
		if m := cloudInitTimestamp.FindStringSubmatch(line); len(m) > 1 {
			ts := strings.Replace(m[1], ",", ".", 1)
			if t, err := time.Parse("2006-01-02 15:04:05.999", ts); err == nil {
				entry.Timestamp = t.UTC().Format(time.RFC3339Nano)
			} else if t, err := time.Parse("2006-01-02 15:04:05", ts); err == nil {
				entry.Timestamp = t.UTC().Format(time.RFC3339Nano)
			}
		}

		// Extract level
		if m := cloudInitLevel.FindStringSubmatch(line); len(m) > 1 {
			entry.Level = normalizeLevel(m[1])
		}

		entry.Message = line
		entries = append(entries, entry)
	}

	return entries, nil
}

func parseCloudInitOutput(path string) ([]LogEntry, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	modTime := info.ModTime().UTC().Format(time.RFC3339)
	var entries []LogEntry
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		entries = append(entries, LogEntry{
			Timestamp: modTime,
			Level:     "info",
			Source:    "cloud-init-output",
			Message:   line,
		})
	}

	return entries, nil
}

// parseJournalJSON parses journalctl --output=json lines into LogEntry slices.
func parseJournalJSON(output, defaultSource string) ([]LogEntry, *string) {
	var entries []LogEntry
	var lastCursor *string

	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}

		var raw map[string]interface{}
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			continue
		}

		entry := LogEntry{
			Level:  "info",
			Source: defaultSource,
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

		// Parse priority to level
		if pri, ok := raw["PRIORITY"].(string); ok {
			entry.Level = priorityToLevel(pri)
		}

		// For Docker entries, derive source from container name
		if containerName, ok := raw["CONTAINER_NAME"].(string); ok && containerName != "" {
			entry.Source = "docker:" + containerName
		}

		// Store cursor for pagination
		if cursor, ok := raw["__CURSOR"].(string); ok {
			c := cursor
			lastCursor = &c
		}

		if entry.Message != "" {
			entries = append(entries, entry)
		}
	}

	return entries, lastCursor
}

// Helper functions

func clampLimit(limit int) int {
	if limit <= 0 {
		return DefaultLimit
	}
	if limit > MaxLimit {
		return MaxLimit
	}
	return limit
}

// Validation patterns for filter inputs passed to journalctl.
var (
	// relativeTimePattern matches relative durations like "-1h", "-30m", "-2d".
	relativeTimePattern = regexp.MustCompile(`^-\d+[smhd]$`)
	// cursorPattern matches journald cursor strings (hex, alphanumeric with delimiters).
	cursorPattern = regexp.MustCompile(`^[a-zA-Z0-9=;_\-]+$`)
	// containerNamePattern matches valid Docker container names.
	containerNamePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.\-]*$`)
	// validSources is the set of allowed source filter values.
	validSources = map[string]bool{
		"all": true, "agent": true, "cloud-init": true, "docker": true, "systemd": true,
	}
	// validLevels is the set of allowed log level values.
	validLevels = map[string]bool{
		"debug": true, "info": true, "warn": true, "error": true,
	}
	// maxSearchLength limits search string length to prevent abuse.
	maxSearchLength = 1000
)

// ValidateFilter checks that all filter fields contain safe values.
// Returns an error describing the first invalid field found.
func ValidateFilter(f LogFilter) error {
	if f.Source != "" && !validSources[strings.ToLower(f.Source)] {
		return fmt.Errorf("invalid source: must be one of all, agent, cloud-init, docker, systemd")
	}
	if f.Level != "" && !validLevels[strings.ToLower(f.Level)] {
		return fmt.Errorf("invalid level: must be one of debug, info, warn, error")
	}
	if f.Container != "" {
		if len(f.Container) > 255 {
			return fmt.Errorf("container name too long (max 255)")
		}
		if !containerNamePattern.MatchString(f.Container) {
			return fmt.Errorf("invalid container name: must match [a-zA-Z0-9][a-zA-Z0-9_.-]*")
		}
	}
	if f.Since != "" {
		if err := validateTimestamp(f.Since); err != nil {
			return fmt.Errorf("invalid since: %w", err)
		}
	}
	if f.Until != "" {
		if err := validateTimestamp(f.Until); err != nil {
			return fmt.Errorf("invalid until: %w", err)
		}
	}
	if f.Cursor != "" {
		if len(f.Cursor) > 512 {
			return fmt.Errorf("cursor too long (max 512)")
		}
		if !cursorPattern.MatchString(f.Cursor) {
			return fmt.Errorf("invalid cursor format")
		}
	}
	if len(f.Search) > maxSearchLength {
		return fmt.Errorf("search string too long (max %d)", maxSearchLength)
	}
	return nil
}

// validateTimestamp checks that a time string is a valid ISO 8601 timestamp
// or a relative duration pattern accepted by journalctl.
func validateTimestamp(s string) error {
	// Relative time: -1h, -30m, -2d, -60s
	if relativeTimePattern.MatchString(s) {
		return nil
	}
	// ISO 8601 / RFC 3339
	if _, err := time.Parse(time.RFC3339, s); err == nil {
		return nil
	}
	// Date only: 2026-02-23
	if _, err := time.Parse("2006-01-02", s); err == nil {
		return nil
	}
	// Date + time without timezone: 2026-02-23 15:30:00
	if _, err := time.Parse("2006-01-02 15:04:05", s); err == nil {
		return nil
	}
	return fmt.Errorf("must be ISO 8601, date (YYYY-MM-DD), or relative (-Ns, -Nm, -Nh, -Nd)")
}

func normalizeTimeArg(s string) string {
	// Values are pre-validated by ValidateFilter before reaching this point.
	return s
}

func journalPriority(level string) string {
	switch strings.ToLower(level) {
	case "error":
		return "err"
	case "warn":
		return "warning"
	case "debug":
		return "debug"
	default:
		return "info"
	}
}

func priorityToLevel(pri string) string {
	switch pri {
	case "0", "1", "2", "3": // emerg, alert, crit, err
		return "error"
	case "4": // warning
		return "warn"
	case "5", "6": // notice, info
		return "info"
	case "7": // debug
		return "debug"
	default:
		return "info"
	}
}

func normalizeLevel(s string) string {
	switch strings.ToUpper(s) {
	case "DEBUG":
		return "debug"
	case "WARNING", "WARN":
		return "warn"
	case "ERROR", "CRITICAL":
		return "error"
	default:
		return "info"
	}
}

var levelOrder = map[string]int{
	"debug": 0,
	"info":  1,
	"warn":  2,
	"error": 3,
}

func filterByLevel(entries []LogEntry, minLevel string) []LogEntry {
	minOrd := levelOrder[strings.ToLower(minLevel)]
	var result []LogEntry
	for _, e := range entries {
		if levelOrder[e.Level] >= minOrd {
			result = append(result, e)
		}
	}
	return result
}

func filterBySearch(entries []LogEntry, search string) []LogEntry {
	lower := strings.ToLower(search)
	var result []LogEntry
	for _, e := range entries {
		if strings.Contains(strings.ToLower(e.Message), lower) {
			result = append(result, e)
		}
	}
	return result
}

func filterByTimeRange(entries []LogEntry, since, until string) []LogEntry {
	var sinceTime, untilTime time.Time
	if since != "" {
		if t, err := time.Parse(time.RFC3339, since); err == nil {
			sinceTime = t
		}
	}
	if until != "" {
		if t, err := time.Parse(time.RFC3339, until); err == nil {
			untilTime = t
		}
	}

	var result []LogEntry
	for _, e := range entries {
		t, err := time.Parse(time.RFC3339Nano, e.Timestamp)
		if err != nil {
			t, err = time.Parse(time.RFC3339, e.Timestamp)
			if err != nil {
				result = append(result, e) // Include if we can't parse
				continue
			}
		}
		if !sinceTime.IsZero() && t.Before(sinceTime) {
			continue
		}
		if !untilTime.IsZero() && t.After(untilTime) {
			continue
		}
		result = append(result, e)
	}
	return result
}

func envInt(key string, defaultVal int) int {
	if v := os.Getenv(key); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return defaultVal
}
