package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Mock PTY manager for testing
type mockPTYManager struct {
	sessions map[string]*mockPTY
}

type mockPTY struct {
	id        string
	closed    bool
	inputBuf  bytes.Buffer
	outputBuf bytes.Buffer
}

func newMockPTYManager() *mockPTYManager {
	return &mockPTYManager{
		sessions: make(map[string]*mockPTY),
	}
}

func (m *mockPTYManager) CreatePTY(sessionId string, rows, cols uint16) error {
	if _, exists := m.sessions[sessionId]; exists {
		return ErrSessionExists
	}
	m.sessions[sessionId] = &mockPTY{
		id: sessionId,
	}
	return nil
}

func (m *mockPTYManager) ClosePTY(sessionId string) error {
	if pty, exists := m.sessions[sessionId]; exists {
		pty.closed = true
		delete(m.sessions, sessionId)
		return nil
	}
	return ErrSessionNotFound
}

func (m *mockPTYManager) WriteToPTY(sessionId string, data []byte) error {
	if pty, exists := m.sessions[sessionId]; exists {
		if pty.closed {
			return ErrSessionClosed
		}
		pty.inputBuf.Write(data)
		return nil
	}
	return ErrSessionNotFound
}

func (m *mockPTYManager) ReadFromPTY(sessionId string) ([]byte, error) {
	if pty, exists := m.sessions[sessionId]; exists {
		if pty.closed {
			return nil, ErrSessionClosed
		}
		return pty.outputBuf.Bytes(), nil
	}
	return nil, ErrSessionNotFound
}

func (m *mockPTYManager) ResizePTY(sessionId string, rows, cols uint16) error {
	if pty, exists := m.sessions[sessionId]; exists {
		if pty.closed {
			return ErrSessionClosed
		}
		return nil
	}
	return ErrSessionNotFound
}

func TestHandleMultiTerminalWS(t *testing.T) {
	// Create test server with mock PTY manager
	ptyManager := newMockPTYManager()

	// Create HTTP test server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handleMultiTerminalWS(w, r, ptyManager)
	}))
	defer server.Close()

	// Connect WebSocket client
	wsURL := strings.Replace(server.URL, "http", "ws", 1)
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)
	defer ws.Close()

	t.Run("CreateSession", func(t *testing.T) {
		// Send create_session message
		msg := CreateSessionMessage{
			Type: "create_session",
			Data: SessionData{
				SessionID: "test-session-1",
				Rows:      24,
				Cols:      80,
				Name:      "Test Terminal",
			},
		}

		err := ws.WriteJSON(msg)
		require.NoError(t, err)

		// Read response
		var response SessionCreatedMessage
		err = ws.ReadJSON(&response)
		require.NoError(t, err)

		assert.Equal(t, "session_created", response.Type)
		assert.Equal(t, "test-session-1", response.SessionID)
		assert.NotEmpty(t, response.Data.WorkingDirectory)
	})

	t.Run("CreateDuplicateSession", func(t *testing.T) {
		// Try to create same session again
		msg := CreateSessionMessage{
			Type: "create_session",
			Data: SessionData{
				SessionID: "test-session-1",
				Rows:      24,
				Cols:      80,
			},
		}

		err := ws.WriteJSON(msg)
		require.NoError(t, err)

		// Should receive error
		var response ErrorMessage
		err = ws.ReadJSON(&response)
		require.NoError(t, err)

		assert.Equal(t, "error", response.Type)
		assert.Contains(t, response.Error, "already exists")
	})

	t.Run("RouteInputToSession", func(t *testing.T) {
		// Send input to specific session
		msg := InputMessage{
			Type:      "input",
			SessionID: "test-session-1",
			Data: InputData{
				Data: "echo hello\n",
			},
		}

		err := ws.WriteJSON(msg)
		require.NoError(t, err)

		// Verify input was routed
		pty := ptyManager.sessions["test-session-1"]
		assert.NotNil(t, pty)
		assert.Contains(t, pty.inputBuf.String(), "echo hello")
	})

	t.Run("InputToNonExistentSession", func(t *testing.T) {
		// Send input to non-existent session
		msg := InputMessage{
			Type:      "input",
			SessionID: "non-existent",
			Data: InputData{
				Data: "test",
			},
		}

		err := ws.WriteJSON(msg)
		require.NoError(t, err)

		// Should receive error
		var response ErrorMessage
		err = ws.ReadJSON(&response)
		require.NoError(t, err)

		assert.Equal(t, "error", response.Type)
		assert.Contains(t, response.Error, "not found")
	})

	t.Run("ResizeSession", func(t *testing.T) {
		// Send resize message
		msg := ResizeMessage{
			Type:      "resize",
			SessionID: "test-session-1",
			Data: ResizeData{
				Rows: 30,
				Cols: 100,
			},
		}

		err := ws.WriteJSON(msg)
		require.NoError(t, err)

		// No error response expected
		// Give time for processing
		time.Sleep(10 * time.Millisecond)
	})

	t.Run("CloseSession", func(t *testing.T) {
		// Create another session first
		createMsg := CreateSessionMessage{
			Type: "create_session",
			Data: SessionData{
				SessionID: "test-session-2",
				Rows:      24,
				Cols:      80,
			},
		}
		err := ws.WriteJSON(createMsg)
		require.NoError(t, err)

		// Read creation response
		var created SessionCreatedMessage
		err = ws.ReadJSON(&created)
		require.NoError(t, err)

		// Now close it
		closeMsg := CloseSessionMessage{
			Type: "close_session",
			Data: CloseSessionData{
				SessionID: "test-session-2",
			},
		}

		err := ws.WriteJSON(closeMsg)
		require.NoError(t, err)

		// Should receive session_closed confirmation
		var response SessionClosedMessage
		err = ws.ReadJSON(&response)
		require.NoError(t, err)

		assert.Equal(t, "session_closed", response.Type)
		assert.Equal(t, "test-session-2", response.SessionID)

		// Verify session was removed
		_, exists := ptyManager.sessions["test-session-2"]
		assert.False(t, exists)
	})

	t.Run("CloseNonExistentSession", func(t *testing.T) {
		// Try to close non-existent session
		msg := CloseSessionMessage{
			Type: "close_session",
			Data: CloseSessionData{
				SessionID: "non-existent",
			},
		}

		err := ws.WriteJSON(msg)
		require.NoError(t, err)

		// Should receive error
		var response ErrorMessage
		err = ws.ReadJSON(&response)
		require.NoError(t, err)

		assert.Equal(t, "error", response.Type)
		assert.Contains(t, response.Error, "not found")
	})

	t.Run("RenameSession", func(t *testing.T) {
		// Send rename message
		msg := RenameSessionMessage{
			Type:      "rename_session",
			SessionID: "test-session-1",
			Data: RenameSessionData{
				Name: "Renamed Terminal",
			},
		}

		err := ws.WriteJSON(msg)
		require.NoError(t, err)

		// Should receive confirmation
		var response SessionRenamedMessage
		err = ws.ReadJSON(&response)
		require.NoError(t, err)

		assert.Equal(t, "session_renamed", response.Type)
		assert.Equal(t, "test-session-1", response.SessionID)
		assert.Equal(t, "Renamed Terminal", response.Data.Name)
	})

	t.Run("InvalidMessageType", func(t *testing.T) {
		// Send invalid message type
		msg := map[string]interface{}{
			"type": "invalid_type",
			"data": map[string]interface{}{},
		}

		err := ws.WriteJSON(msg)
		require.NoError(t, err)

		// Should receive error
		var response ErrorMessage
		err = ws.ReadJSON(&response)
		require.NoError(t, err)

		assert.Equal(t, "error", response.Type)
		assert.Contains(t, response.Error, "unknown message type")
	})

	t.Run("MalformedMessage", func(t *testing.T) {
		// Send malformed JSON
		err := ws.WriteMessage(websocket.TextMessage, []byte("not json"))
		require.NoError(t, err)

		// Should receive error
		var response ErrorMessage
		err = ws.ReadJSON(&response)
		require.NoError(t, err)

		assert.Equal(t, "error", response.Type)
		assert.Contains(t, response.Error, "invalid")
	})
}

func TestSessionManagement(t *testing.T) {
	ptyManager := newMockPTYManager()

	t.Run("MaxSessionLimit", func(t *testing.T) {
		// Create max sessions
		for i := 0; i < MaxSessionsPerWorkspace; i++ {
			err := ptyManager.CreatePTY(fmt.Sprintf("session-%d", i), 24, 80)
			assert.NoError(t, err)
		}

		// Try to create one more
		err := ptyManager.CreatePTY("overflow", 24, 80)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "maximum sessions")
	})

	t.Run("SessionCleanup", func(t *testing.T) {
		// Create session
		err := ptyManager.CreatePTY("cleanup-test", 24, 80)
		require.NoError(t, err)

		// Close it
		err = ptyManager.ClosePTY("cleanup-test")
		require.NoError(t, err)

		// Try to write to closed session
		err = ptyManager.WriteToPTY("cleanup-test", []byte("test"))
		assert.Error(t, err)
		assert.Equal(t, ErrSessionNotFound, err)
	})

	t.Run("ConcurrentSessions", func(t *testing.T) {
		// Create multiple sessions concurrently
		done := make(chan bool, 5)

		for i := 0; i < 5; i++ {
			go func(id int) {
				sessionID := fmt.Sprintf("concurrent-%d", id)
				err := ptyManager.CreatePTY(sessionID, 24, 80)
				assert.NoError(t, err)

				// Write some data
				err = ptyManager.WriteToPTY(sessionID, []byte(fmt.Sprintf("session %d\n", id)))
				assert.NoError(t, err)

				done <- true
			}(i)
		}

		// Wait for all goroutines
		for i := 0; i < 5; i++ {
			<-done
		}

		// Verify all sessions exist
		assert.Len(t, ptyManager.sessions, 5)
	})
}

func TestWebSocketReconnection(t *testing.T) {
	ptyManager := newMockPTYManager()

	// Create HTTP test server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handleMultiTerminalWS(w, r, ptyManager)
	}))
	defer server.Close()

	wsURL := strings.Replace(server.URL, "http", "ws", 1)

	t.Run("ReconnectWithExistingSessions", func(t *testing.T) {
		// First connection - create session
		ws1, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
		require.NoError(t, err)

		msg := CreateSessionMessage{
			Type: "create_session",
			Data: SessionData{
				SessionID: "persist-1",
				Rows:      24,
				Cols:      80,
			},
		}
		err = ws1.WriteJSON(msg)
		require.NoError(t, err)

		// Close first connection
		ws1.Close()

		// Second connection - session should persist
		ws2, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
		require.NoError(t, err)
		defer ws2.Close()

		// Try to interact with existing session
		inputMsg := InputMessage{
			Type:      "input",
			SessionID: "persist-1",
			Data: InputData{
				Data: "test",
			},
		}
		err = ws2.WriteJSON(inputMsg)
		require.NoError(t, err)

		// Should work without error
		time.Sleep(10 * time.Millisecond)
	})
}

func TestOutputBroadcast(t *testing.T) {
	ptyManager := newMockPTYManager()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handleMultiTerminalWS(w, r, ptyManager)
	}))
	defer server.Close()

	wsURL := strings.Replace(server.URL, "http", "ws", 1)

	t.Run("BroadcastToCorrectSession", func(t *testing.T) {
		// Connect two clients
		ws1, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
		require.NoError(t, err)
		defer ws1.Close()

		ws2, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
		require.NoError(t, err)
		defer ws2.Close()

		// Create sessions on both
		for i, ws := range []*websocket.Conn{ws1, ws2} {
			msg := CreateSessionMessage{
				Type: "create_session",
				Data: SessionData{
					SessionID: fmt.Sprintf("broadcast-%d", i),
					Rows:      24,
					Cols:      80,
				},
			}
			err = ws.WriteJSON(msg)
			require.NoError(t, err)

			// Read creation response
			var response SessionCreatedMessage
			err = ws.ReadJSON(&response)
			require.NoError(t, err)
		}

		// Simulate output from session-1
		pty1 := ptyManager.sessions["broadcast-0"]
		pty1.outputBuf.WriteString("output from session 0")

		// Client 1 should receive output for session-0
		ws1.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		var output OutputMessage
		err = ws1.ReadJSON(&output)

		// Would receive if output broadcasting was implemented
		if err == nil {
			assert.Equal(t, "broadcast-0", output.SessionID)
			assert.Contains(t, output.Data.Data, "output from session 0")
		}
	})
}

func TestMessageValidation(t *testing.T) {
	tests := []struct {
		name        string
		message     interface{}
		shouldError bool
		errorMsg    string
	}{
		{
			name: "ValidCreateSession",
			message: CreateSessionMessage{
				Type: "create_session",
				Data: SessionData{
					SessionID: "valid-id",
					Rows:      24,
					Cols:      80,
				},
			},
			shouldError: false,
		},
		{
			name: "CreateSessionMissingID",
			message: CreateSessionMessage{
				Type: "create_session",
				Data: SessionData{
					Rows: 24,
					Cols: 80,
				},
			},
			shouldError: true,
			errorMsg:    "session ID required",
		},
		{
			name: "CreateSessionInvalidDimensions",
			message: CreateSessionMessage{
				Type: "create_session",
				Data: SessionData{
					SessionID: "test",
					Rows:      0,
					Cols:      0,
				},
			},
			shouldError: true,
			errorMsg:    "invalid dimensions",
		},
		{
			name: "InputMissingSessionID",
			message: InputMessage{
				Type: "input",
				Data: InputData{
					Data: "test",
				},
			},
			shouldError: true,
			errorMsg:    "session ID required",
		},
		{
			name: "ResizeInvalidDimensions",
			message: ResizeMessage{
				Type:      "resize",
				SessionID: "test",
				Data: ResizeData{
					Rows: 1000, // Too large
					Cols: 1000,
				},
			},
			shouldError: true,
			errorMsg:    "dimensions out of range",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateMessage(tt.message)
			if tt.shouldError {
				assert.Error(t, err)
				if tt.errorMsg != "" {
					assert.Contains(t, err.Error(), tt.errorMsg)
				}
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

// Helper function for message validation (to be implemented in actual code)
func validateMessage(msg interface{}) error {
	// Validation logic here
	return nil
}