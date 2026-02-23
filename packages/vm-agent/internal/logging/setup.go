// Package logging configures structured logging for the VM Agent using log/slog.
package logging

import (
	"io"
	"log"
	"log/slog"
	"os"
	"strings"
)

// Level is a package-level LevelVar that allows runtime log level changes.
var Level slog.LevelVar

// Setup initialises the default slog logger from environment variables:
//
//   - LOG_LEVEL: debug, info, warn, error (default: info)
//   - LOG_FORMAT: json, text (default: json)
//
// It also bridges the standard library "log" package so that third-party
// libraries using log.Printf are captured in structured format.
func Setup() {
	levelStr := os.Getenv("LOG_LEVEL")
	formatStr := os.Getenv("LOG_FORMAT")

	SetupWithConfig(levelStr, formatStr, os.Stderr)
}

// SetupWithConfig configures slog with explicit parameters (useful for testing).
func SetupWithConfig(levelStr, formatStr string, w io.Writer) {
	Level.Set(ParseLevel(levelStr))

	var handler slog.Handler
	opts := &slog.HandlerOptions{Level: &Level}

	switch strings.ToLower(strings.TrimSpace(formatStr)) {
	case "text":
		handler = slog.NewTextHandler(w, opts)
	default:
		handler = slog.NewJSONHandler(w, opts)
	}

	logger := slog.New(handler)
	slog.SetDefault(logger)

	// Bridge stdlib log -> slog so that third-party log.Printf calls
	// are captured with structured output at INFO level.
	log.SetOutput(newSlogWriter(logger))
	log.SetFlags(0) // slog handles timestamps
}

// ParseLevel converts a string to slog.Level. Defaults to INFO.
func ParseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// slogWriter adapts slog.Logger to io.Writer for the stdlib log bridge.
type slogWriter struct {
	logger *slog.Logger
}

func newSlogWriter(logger *slog.Logger) *slogWriter {
	return &slogWriter{logger: logger}
}

func (w *slogWriter) Write(p []byte) (n int, err error) {
	msg := strings.TrimRight(string(p), "\n")
	w.logger.Info(msg, "source", "stdlib")
	return len(p), nil
}
