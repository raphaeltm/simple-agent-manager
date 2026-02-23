package logging

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

func TestParseLevel(t *testing.T) {
	tests := []struct {
		input string
		want  slog.Level
	}{
		{"debug", slog.LevelDebug},
		{"DEBUG", slog.LevelDebug},
		{"info", slog.LevelInfo},
		{"INFO", slog.LevelInfo},
		{"warn", slog.LevelWarn},
		{"warning", slog.LevelWarn},
		{"error", slog.LevelError},
		{"ERROR", slog.LevelError},
		{"", slog.LevelInfo},
		{"invalid", slog.LevelInfo},
		{"  debug  ", slog.LevelDebug},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := ParseLevel(tt.input)
			if got != tt.want {
				t.Errorf("ParseLevel(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

func TestSetupWithConfig_JSONFormat(t *testing.T) {
	var buf bytes.Buffer
	SetupWithConfig("info", "json", &buf)

	slog.Info("test message", "key", "value")

	var entry map[string]interface{}
	if err := json.Unmarshal(buf.Bytes(), &entry); err != nil {
		t.Fatalf("failed to parse JSON log: %v (output: %s)", err, buf.String())
	}

	if msg, ok := entry["msg"].(string); !ok || msg != "test message" {
		t.Errorf("msg = %v, want %q", entry["msg"], "test message")
	}
	if key, ok := entry["key"].(string); !ok || key != "value" {
		t.Errorf("key = %v, want %q", entry["key"], "value")
	}
}

func TestSetupWithConfig_TextFormat(t *testing.T) {
	var buf bytes.Buffer
	SetupWithConfig("info", "text", &buf)

	slog.Info("hello text")

	output := buf.String()
	if !strings.Contains(output, "hello text") {
		t.Errorf("text output should contain message, got: %s", output)
	}
	// Text format should NOT be valid JSON
	var entry map[string]interface{}
	if err := json.Unmarshal(buf.Bytes(), &entry); err == nil {
		t.Errorf("text format should not parse as JSON")
	}
}

func TestSetupWithConfig_LevelFiltering(t *testing.T) {
	var buf bytes.Buffer
	SetupWithConfig("warn", "json", &buf)

	slog.Info("should be filtered")
	if buf.Len() > 0 {
		t.Errorf("INFO should be filtered at WARN level, got: %s", buf.String())
	}

	slog.Warn("should appear")
	if buf.Len() == 0 {
		t.Error("WARN should not be filtered at WARN level")
	}
}

func TestLevelVar_RuntimeChange(t *testing.T) {
	var buf bytes.Buffer
	SetupWithConfig("error", "json", &buf)

	slog.Info("before change")
	if buf.Len() > 0 {
		t.Errorf("INFO should be filtered at ERROR level")
	}

	// Change level at runtime
	Level.Set(slog.LevelDebug)

	slog.Debug("after change")
	if buf.Len() == 0 {
		t.Error("DEBUG should pass after level change to DEBUG")
	}
}

func TestSlogWriter_BridgesStdlib(t *testing.T) {
	var buf bytes.Buffer
	SetupWithConfig("info", "json", &buf)

	// Use stdlib log which should be bridged to slog
	stdLogger := slog.Default()
	w := newSlogWriter(stdLogger)
	_, _ = w.Write([]byte("stdlib message\n"))

	var entry map[string]interface{}
	if err := json.Unmarshal(buf.Bytes(), &entry); err != nil {
		t.Fatalf("failed to parse bridged log: %v", err)
	}

	if msg, ok := entry["msg"].(string); !ok || msg != "stdlib message" {
		t.Errorf("msg = %v, want %q", entry["msg"], "stdlib message")
	}
	if src, ok := entry["source"].(string); !ok || src != "stdlib" {
		t.Errorf("source = %v, want %q", entry["source"], "stdlib")
	}
}
