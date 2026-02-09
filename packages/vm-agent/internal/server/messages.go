package server

import (
	"encoding/json"
	"time"
)

// MessageType represents the type of WebSocket message
type MessageType string

const (
	// Client -> Server message types
	MessageTypeInput            MessageType = "input"
	MessageTypeResize           MessageType = "resize"
	MessageTypePing             MessageType = "ping"
	MessageTypeCreateSession    MessageType = "create_session"
	MessageTypeCloseSession     MessageType = "close_session"
	MessageTypeRenameSession    MessageType = "rename_session"
	MessageTypeListSessions     MessageType = "list_sessions"
	MessageTypeReattachSession  MessageType = "reattach_session"

	// Server -> Client message types
	MessageTypeOutput            MessageType = "output"
	MessageTypeSession           MessageType = "session"
	MessageTypeError             MessageType = "error"
	MessageTypePong              MessageType = "pong"
	MessageTypeSessionCreated    MessageType = "session_created"
	MessageTypeSessionClosed     MessageType = "session_closed"
	MessageTypeSessionRenamed    MessageType = "session_renamed"
	MessageTypeSessionList       MessageType = "session_list"
	MessageTypeSessionReattached MessageType = "session_reattached"
	MessageTypeScrollback        MessageType = "scrollback"
)

// BaseMessage is the common structure for all WebSocket messages
type BaseMessage struct {
	Type      MessageType     `json:"type"`
	SessionID string          `json:"sessionId,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
}

// Client -> Server Messages

// InputMessage represents terminal input from client
type InputMessage struct {
	Data string `json:"data"`
}

// ResizeMessage represents terminal resize request
type ResizeMessage struct {
	Rows int `json:"rows"`
	Cols int `json:"cols"`
}

// CreateSessionMessage requests creation of a new terminal session
type CreateSessionMessage struct {
	SessionID string `json:"sessionId"`
	Rows      int    `json:"rows"`
	Cols      int    `json:"cols"`
	Name      string `json:"name,omitempty"`
}

// CloseSessionMessage requests closure of a terminal session
type CloseSessionMessage struct {
	SessionID string `json:"sessionId"`
}

// RenameSessionMessage requests renaming of a terminal session
type RenameSessionMessage struct {
	SessionID string `json:"sessionId"`
	Name      string `json:"name"`
}

// Server -> Client Messages

// OutputMessage represents terminal output to client
type OutputMessage struct {
	Data string `json:"data"`
}

// SessionMessage represents session information
type SessionMessage struct {
	SessionID string `json:"sessionId"`
}

// SessionCreatedMessage confirms session creation
type SessionCreatedMessage struct {
	SessionID        string `json:"sessionId"`
	WorkingDirectory string `json:"workingDirectory,omitempty"`
	Shell            string `json:"shell,omitempty"`
}

// SessionClosedMessage confirms session closure
type SessionClosedMessage struct {
	SessionID string                 `json:"sessionId"`
	Reason    SessionClosureReason   `json:"reason"`
	ExitCode  int                    `json:"exitCode,omitempty"`
}

// SessionClosureReason represents why a session was closed
type SessionClosureReason string

const (
	ClosureReasonUserRequested SessionClosureReason = "user_requested"
	ClosureReasonIdleTimeout   SessionClosureReason = "idle_timeout"
	ClosureReasonProcessExit   SessionClosureReason = "process_exit"
	ClosureReasonError         SessionClosureReason = "error"
)

// SessionRenamedMessage confirms session rename
type SessionRenamedMessage struct {
	SessionID string `json:"sessionId"`
	Name      string `json:"name"`
}

// ReattachSessionMessage requests reattachment to an existing session
type ReattachSessionMessage struct {
	SessionID string `json:"sessionId"`
	Rows      int    `json:"rows"`
	Cols      int    `json:"cols"`
}

// SessionReattachedMessage confirms session reattachment
type SessionReattachedMessage struct {
	SessionID        string `json:"sessionId"`
	WorkingDirectory string `json:"workingDirectory,omitempty"`
	Shell            string `json:"shell,omitempty"`
}

// ScrollbackMessage contains buffered output to replay on reconnect
type ScrollbackMessage struct {
	Data string `json:"data"`
}

// SessionInfo represents information about a terminal session
type SessionInfo struct {
	SessionID        string    `json:"sessionId"`
	Name             string    `json:"name,omitempty"`
	Status           string    `json:"status"` // "running" or "exited"
	WorkingDirectory string    `json:"workingDirectory,omitempty"`
	CreatedAt        time.Time `json:"createdAt"`
	LastActivityAt   time.Time `json:"lastActivityAt,omitempty"`
}

// SessionListMessage contains list of all sessions
type SessionListMessage struct {
	Sessions []SessionInfo `json:"sessions"`
}

// ErrorMessage represents an error message
type ErrorMessage struct {
	Error   string `json:"error"`
	Details string `json:"details,omitempty"`
}

// Helper functions for message creation

// NewOutputMessage creates a new output message
func NewOutputMessage(sessionID, data string) []byte {
	msg := BaseMessage{
		Type:      MessageTypeOutput,
		SessionID: sessionID,
	}
	outputData, _ := json.Marshal(OutputMessage{Data: data})
	msg.Data = outputData
	result, _ := json.Marshal(msg)
	return result
}

// NewSessionCreatedMessage creates a session created message
func NewSessionCreatedMessage(sessionID, workingDir, shell string) []byte {
	msg := BaseMessage{
		Type:      MessageTypeSessionCreated,
		SessionID: sessionID,
	}
	data, _ := json.Marshal(SessionCreatedMessage{
		SessionID:        sessionID,
		WorkingDirectory: workingDir,
		Shell:            shell,
	})
	msg.Data = data
	result, _ := json.Marshal(msg)
	return result
}

// NewSessionClosedMessage creates a session closed message
func NewSessionClosedMessage(sessionID string, reason SessionClosureReason, exitCode int) []byte {
	msg := BaseMessage{
		Type:      MessageTypeSessionClosed,
		SessionID: sessionID,
	}
	data, _ := json.Marshal(SessionClosedMessage{
		SessionID: sessionID,
		Reason:    reason,
		ExitCode:  exitCode,
	})
	msg.Data = data
	result, _ := json.Marshal(msg)
	return result
}

// NewErrorMessage creates an error message
func NewErrorMessage(sessionID, error, details string) []byte {
	msg := BaseMessage{
		Type:      MessageTypeError,
		SessionID: sessionID,
	}
	data, _ := json.Marshal(ErrorMessage{
		Error:   error,
		Details: details,
	})
	msg.Data = data
	result, _ := json.Marshal(msg)
	return result
}

// NewPongMessage creates a pong message
func NewPongMessage(sessionID string) []byte {
	msg := BaseMessage{
		Type:      MessageTypePong,
		SessionID: sessionID,
	}
	result, _ := json.Marshal(msg)
	return result
}

// NewSessionListMessage creates a session list message
func NewSessionListMessage(sessions []SessionInfo) []byte {
	msg := BaseMessage{
		Type: MessageTypeSessionList,
	}
	data, _ := json.Marshal(SessionListMessage{
		Sessions: sessions,
	})
	msg.Data = data
	result, _ := json.Marshal(msg)
	return result
}

// ParseMessage parses a raw WebSocket message
func ParseMessage(data []byte) (*BaseMessage, error) {
	var msg BaseMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil, err
	}
	return &msg, nil
}

// ParseInputMessage parses input message data
func ParseInputMessage(data json.RawMessage) (*InputMessage, error) {
	var msg InputMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil, err
	}
	return &msg, nil
}

// ParseResizeMessage parses resize message data
func ParseResizeMessage(data json.RawMessage) (*ResizeMessage, error) {
	var msg ResizeMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil, err
	}
	return &msg, nil
}

// ParseCreateSessionMessage parses create session message data
func ParseCreateSessionMessage(data json.RawMessage) (*CreateSessionMessage, error) {
	var msg CreateSessionMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil, err
	}
	return &msg, nil
}

// ParseCloseSessionMessage parses close session message data
func ParseCloseSessionMessage(data json.RawMessage) (*CloseSessionMessage, error) {
	var msg CloseSessionMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil, err
	}
	return &msg, nil
}

// ParseRenameSessionMessage parses rename session message data
func ParseRenameSessionMessage(data json.RawMessage) (*RenameSessionMessage, error) {
	var msg RenameSessionMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil, err
	}
	return &msg, nil
}

// ParseReattachSessionMessage parses reattach session message data
func ParseReattachSessionMessage(data json.RawMessage) (*ReattachSessionMessage, error) {
	var msg ReattachSessionMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil, err
	}
	return &msg, nil
}

// NewSessionReattachedMessage creates a session reattached message
func NewSessionReattachedMessage(sessionID, workingDir, shell string) []byte {
	msg := BaseMessage{
		Type:      MessageTypeSessionReattached,
		SessionID: sessionID,
	}
	data, _ := json.Marshal(SessionReattachedMessage{
		SessionID:        sessionID,
		WorkingDirectory: workingDir,
		Shell:            shell,
	})
	msg.Data = data
	result, _ := json.Marshal(msg)
	return result
}

// NewScrollbackMessage creates a scrollback message with buffered output
func NewScrollbackMessage(sessionID, data string) []byte {
	msg := BaseMessage{
		Type:      MessageTypeScrollback,
		SessionID: sessionID,
	}
	scrollData, _ := json.Marshal(ScrollbackMessage{
		Data: data,
	})
	msg.Data = scrollData
	result, _ := json.Marshal(msg)
	return result
}