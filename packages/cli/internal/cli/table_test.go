package cli

import (
	"strings"
	"testing"
	"time"
)

func TestPrintTable(t *testing.T) {
	var sb strings.Builder
	headers := []string{"ID", "NAME", "STATUS"}
	rows := [][]string{
		{"abc", "First Project", "active"},
		{"defghij", "X", "stopped"},
	}
	PrintTable(&sb, headers, rows)
	output := sb.String()
	lines := strings.Split(strings.TrimRight(output, "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines, got %d: %s", len(lines), output)
	}
	if !strings.Contains(lines[0], "ID") || !strings.Contains(lines[0], "NAME") {
		t.Fatalf("header = %s", lines[0])
	}
	if !strings.Contains(lines[1], "First Project") {
		t.Fatalf("row 1 = %s", lines[1])
	}
}

func TestPrintTableSanitizesMultilineCells(t *testing.T) {
	var sb strings.Builder
	PrintTable(&sb, []string{"ID", "TITLE"}, [][]string{{"1", "first line\nsecond\tline"}})

	output := strings.TrimRight(sb.String(), "\n")
	lines := strings.Split(output, "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 lines, got %d: %s", len(lines), output)
	}
	if !strings.Contains(lines[1], "first line second line") {
		t.Fatalf("row = %s", lines[1])
	}
}

func TestTruncateID(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"01ABCDEFGHIJKLMNOPQRSTUVWX", "01ABCDE..."},
		{"short", "short"},
		{"1234567", "1234567"},
		{"12345678", "1234567..."},
	}
	for _, tt := range tests {
		if got := TruncateID(tt.input); got != tt.want {
			t.Errorf("TruncateID(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestRelativeTime(t *testing.T) {
	tests := []struct {
		d    time.Duration
		want string
	}{
		{0, "just now"},
		{30 * time.Second, "just now"},
		{5 * time.Minute, "5m ago"},
		{2 * time.Hour, "2h ago"},
		{3 * 24 * time.Hour, "3d ago"},
		{14 * 24 * time.Hour, "2w ago"},
		{-1 * time.Second, "just now"},
	}
	for _, tt := range tests {
		if got := RelativeTime(tt.d); got != tt.want {
			t.Errorf("RelativeTime(%v) = %q, want %q", tt.d, got, tt.want)
		}
	}
}

func TestFormatAnyTimestampHandlesNumericMilliseconds(t *testing.T) {
	got := FormatAnyTimestamp(float64(time.Now().Add(-2 * time.Hour).UnixMilli()))
	if got != "2h ago" {
		t.Fatalf("FormatAnyTimestamp numeric milliseconds = %q", got)
	}
}

func TestFormatSize(t *testing.T) {
	tests := []struct {
		bytes int64
		want  string
	}{
		{0, "0 B"},
		{512, "512 B"},
		{1024, "1.0 KB"},
		{1536, "1.5 KB"},
		{1048576, "1.0 MB"},
		{2621440, "2.5 MB"},
	}
	for _, tt := range tests {
		if got := FormatSize(tt.bytes); got != tt.want {
			t.Errorf("FormatSize(%d) = %q, want %q", tt.bytes, got, tt.want)
		}
	}
}

func TestOr(t *testing.T) {
	if got := or("value", "fallback"); got != "value" {
		t.Errorf("or(value, fallback) = %q", got)
	}
	if got := or("", "fallback"); got != "fallback" {
		t.Errorf("or('', fallback) = %q", got)
	}
	if got := or("  ", "fallback"); got != "fallback" {
		t.Errorf("or('  ', fallback) = %q", got)
	}
}
