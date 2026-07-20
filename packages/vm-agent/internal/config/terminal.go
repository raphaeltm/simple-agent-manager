// Package config provides terminal-specific configuration defaults.
package config

import "time"

const (
	// DefaultTerminalWSMaxMessageBytes bounds a single client WebSocket
	// message on terminal sockets. Override via TERMINAL_WS_MAX_MESSAGE_BYTES.
	DefaultTerminalWSMaxMessageBytes = 64 * 1024

	// DefaultTerminalWSReadTimeout bounds idle terminal WebSocket connections
	// between client messages/pongs. Override via TERMINAL_WS_READ_TIMEOUT.
	DefaultTerminalWSReadTimeout = 90 * time.Second

	// DefaultTerminalWSPingInterval keeps terminal WebSocket connections alive
	// and detects dead peers. Override via TERMINAL_WS_PING_INTERVAL.
	DefaultTerminalWSPingInterval = 30 * time.Second

	// DefaultTerminalWSMessageRate limits accepted client messages per second per
	// terminal WebSocket connection. Override via TERMINAL_WS_MESSAGE_RATE.
	DefaultTerminalWSMessageRate = 30

	// DefaultTerminalWSMessageBurst permits short interactive bursts above the
	// steady-state rate. Override via TERMINAL_WS_MESSAGE_BURST.
	DefaultTerminalWSMessageBurst = 60

	// DefaultTerminalSessionIDMaxLength bounds client-supplied terminal session
	// IDs before they are used as PTY or tab identifiers. Override via
	// TERMINAL_SESSION_ID_MAX_LENGTH.
	DefaultTerminalSessionIDMaxLength = 128
)
