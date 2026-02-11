// Package server provides WebSocket terminal handler.
package server

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
)

// createUpgrader creates a WebSocket upgrader with proper origin validation.
// WebSocket upgrades bypass CORS, so we must validate origins explicitly.
// Buffer sizes are configurable via environment variables.
func (s *Server) createUpgrader() websocket.Upgrader {
	return websocket.Upgrader{
		ReadBufferSize:  s.config.WSReadBufferSize,
		WriteBufferSize: s.config.WSWriteBufferSize,
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			if origin == "" {
				// No origin header - likely same-origin or non-browser client
				return true
			}
			return s.isOriginAllowed(origin)
		},
	}
}

// isOriginAllowed checks if the given origin is in the allowed list.
// Supports wildcard patterns like "https://*.example.com".
func (s *Server) isOriginAllowed(origin string) bool {
	for _, allowed := range s.config.AllowedOrigins {
		if allowed == "*" {
			// Wildcard allows all - only for development
			return true
		}
		if allowed == origin {
			// Exact match
			return true
		}
		// Check for wildcard subdomain pattern (e.g., "https://*.example.com")
		if strings.Contains(allowed, "*") {
			if matchWildcardOrigin(origin, allowed) {
				return true
			}
		}
	}
	log.Printf("WebSocket origin rejected: %s (allowed: %v)", origin, s.config.AllowedOrigins)
	return false
}

// matchWildcardOrigin checks if origin matches a wildcard pattern.
// Pattern format: "https://*.example.com" matches "https://foo.example.com"
func matchWildcardOrigin(origin, pattern string) bool {
	// Split pattern at wildcard
	parts := strings.SplitN(pattern, "*", 2)
	if len(parts) != 2 {
		return false
	}
	prefix := parts[0] // e.g., "https://"
	suffix := parts[1] // e.g., ".example.com"

	// Origin must start with prefix and end with suffix
	if !strings.HasPrefix(origin, prefix) {
		return false
	}
	if !strings.HasSuffix(origin, suffix) {
		return false
	}

	// The middle part (subdomain) must not contain "/"
	middle := origin[len(prefix) : len(origin)-len(suffix)]
	if strings.Contains(middle, "/") {
		return false
	}

	return true
}

// WebSocket message types (extended for multi-session support)
type wsMessage struct {
	Type      string          `json:"type"`
	SessionID string          `json:"sessionId,omitempty"` // Added for multi-terminal
	Data      json.RawMessage `json:"data,omitempty"`
}

type wsInputData struct {
	Data string `json:"data"`
}

type wsResizeData struct {
	Rows int `json:"rows"`
	Cols int `json:"cols"`
}

// Multi-terminal message data structures
type wsCreateSessionData struct {
	SessionID string `json:"sessionId"`
	Rows      int    `json:"rows"`
	Cols      int    `json:"cols"`
	Name      string `json:"name,omitempty"`
}

type wsCloseSessionData struct {
	SessionID string `json:"sessionId"`
}

type wsRenameSessionData struct {
	SessionID string `json:"sessionId"`
	Name      string `json:"name"`
}

type wsReattachSessionData struct {
	SessionID string `json:"sessionId"`
	Rows      int    `json:"rows"`
	Cols      int    `json:"cols"`
}

// wsWriter wraps a WebSocket connection and mutex to implement io.Writer.
// Used as the attached writer for PTY sessions to forward output to WebSocket.
type wsWriter struct {
	conn      *websocket.Conn
	writeMu   *sync.Mutex
	sessionID string
}

func (w *wsWriter) Write(p []byte) (int, error) {
	outputData, _ := json.Marshal(map[string]string{"data": string(p)})
	w.writeMu.Lock()
	err := w.conn.WriteJSON(wsMessage{
		Type:      "output",
		SessionID: w.sessionID,
		Data:      outputData,
	})
	w.writeMu.Unlock()
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

// handleTerminalWS handles WebSocket connections for terminal access.
func (s *Server) handleTerminalWS(w http.ResponseWriter, r *http.Request) {
	// Check authentication
	session := s.sessionManager.GetSessionFromRequest(r)
	if session == nil {
		// Try to get token from query param (for initial connection)
		token := r.URL.Query().Get("token")
		if token != "" {
			claims, err := s.jwtValidator.Validate(token)
			if err != nil {
				log.Printf("WebSocket auth failed: %v", err)
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
			// Create session for this connection
			session, err = s.sessionManager.CreateSession(claims)
			if err != nil {
				log.Printf("Failed to create session: %v", err)
				http.Error(w, "Internal Server Error", http.StatusInternalServerError)
				return
			}
		} else {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
	}

	// Upgrade to WebSocket with origin validation
	upgrader := s.createUpgrader()
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	// Get terminal size from query params
	rows := 24
	cols := 80
	if r.URL.Query().Get("rows") != "" {
		if err := json.Unmarshal([]byte(r.URL.Query().Get("rows")), &rows); err != nil {
			rows = 24
		}
	}
	if r.URL.Query().Get("cols") != "" {
		if err := json.Unmarshal([]byte(r.URL.Query().Get("cols")), &cols); err != nil {
			cols = 80
		}
	}

	// Create PTY session
	ptySession, err := s.ptyManager.CreateSession(session.UserID, rows, cols)
	if err != nil {
		log.Printf("Failed to create PTY session: %v", err)
		_ = conn.WriteJSON(wsMessage{Type: "error", Data: json.RawMessage(`"Failed to create terminal session"`)})
		return
	}
	defer s.ptyManager.CloseSession(ptySession.ID)

	// Record activity
	s.idleDetector.RecordActivity()

	// Send session ID to client
	sessionData, _ := json.Marshal(map[string]string{"sessionId": ptySession.ID})
	_ = conn.WriteJSON(wsMessage{Type: "session", Data: sessionData})

	// Create mutex for writing to websocket
	var writeMu sync.Mutex

	// Start PTY output reader
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 4096)
		for {
			n, err := ptySession.Read(buf)
			if err != nil {
				log.Printf("PTY read error: %v", err)
				return
			}
			if n > 0 {
				// Don't record PTY output as activity - background processes
				// and shell prompts would prevent idle shutdown
				outputData, _ := json.Marshal(map[string]string{"data": string(buf[:n])})
				writeMu.Lock()
				err = conn.WriteJSON(wsMessage{Type: "output", Data: outputData})
				writeMu.Unlock()
				if err != nil {
					log.Printf("WebSocket write error: %v", err)
					return
				}
			}
		}
	}()

	// Handle WebSocket messages
	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			log.Printf("WebSocket read error: %v", err)
			break
		}

		var msg wsMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Printf("Invalid message format: %v", err)
			continue
		}

		switch msg.Type {
		case "input":
			var input wsInputData
			if err := json.Unmarshal(msg.Data, &input); err != nil {
				log.Printf("Invalid input data: %v", err)
				continue
			}
			s.idleDetector.RecordActivity()
			if _, err := ptySession.Write([]byte(input.Data)); err != nil {
				log.Printf("PTY write error: %v", err)
				break
			}

		case "resize":
			var resize wsResizeData
			if err := json.Unmarshal(msg.Data, &resize); err != nil {
				log.Printf("Invalid resize data: %v", err)
				continue
			}
			if err := ptySession.Resize(resize.Rows, resize.Cols); err != nil {
				log.Printf("PTY resize error: %v", err)
			}

		case "ping":
			// Don't record activity for pings - they're automatic heartbeats
			// sent every 30s regardless of user interaction
			writeMu.Lock()
			_ = conn.WriteJSON(wsMessage{Type: "pong"})
			writeMu.Unlock()

		default:
			log.Printf("Unknown message type: %s", msg.Type)
		}
	}

	// Wait for output reader to finish
	<-done
}

// handleMultiTerminalWS handles WebSocket connections for multiple terminal sessions.
// This is an enhanced version that supports the multi-terminal protocol with session persistence.
// Sessions survive WebSocket disconnects (page refresh, network interruption) and can be reattached.
func (s *Server) handleMultiTerminalWS(w http.ResponseWriter, r *http.Request) {
	// Check authentication
	session := s.sessionManager.GetSessionFromRequest(r)
	if session == nil {
		// Try to get token from query param (for initial connection)
		token := r.URL.Query().Get("token")
		if token != "" {
			claims, err := s.jwtValidator.Validate(token)
			if err != nil {
				log.Printf("WebSocket auth failed: %v", err)
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
			// Create session for this connection
			session, err = s.sessionManager.CreateSession(claims)
			if err != nil {
				log.Printf("Failed to create session: %v", err)
				http.Error(w, "Internal Server Error", http.StatusInternalServerError)
				return
			}
		} else {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
	}

	// Upgrade to WebSocket
	upgrader := s.createUpgrader()
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	// Set of session IDs attached to THIS WebSocket connection (local tracking only).
	// Sessions themselves live in the global PTY Manager.
	attachedSessions := make(map[string]struct{})
	var asMu sync.Mutex

	// Create mutex for writing to websocket
	var writeMu sync.Mutex

	// On disconnect: orphan all attached sessions instead of closing them
	defer func() {
		asMu.Lock()
		ids := make([]string, 0, len(attachedSessions))
		for id := range attachedSessions {
			ids = append(ids, id)
		}
		asMu.Unlock()

		if len(ids) > 0 {
			log.Printf("WebSocket disconnected, orphaning %d sessions", len(ids))
			// Clear attached writers before orphaning
			for _, id := range ids {
				if sess := s.ptyManager.GetSession(id); sess != nil {
					sess.SetAttachedWriter(nil)
				}
			}
			s.ptyManager.OrphanSessions(ids)
		}
	}()

	// Helper: attach a WebSocket writer to a session for live output forwarding
	attachWriter := func(sessionID string) {
		sess := s.ptyManager.GetSession(sessionID)
		if sess == nil {
			return
		}
		writer := &wsWriter{conn: conn, writeMu: &writeMu, sessionID: sessionID}
		sess.SetAttachedWriter(writer)
	}

	// Handle WebSocket messages
	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			log.Printf("WebSocket read error: %v", err)
			break
		}

		var msg wsMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Printf("Invalid message format: %v", err)
			continue
		}

		switch msg.Type {
		case "list_sessions":
			// Return all active sessions from the global Manager
			activeSessions := s.ptyManager.GetActiveSessions()
			sessionInfos := make([]SessionInfo, len(activeSessions))
			for i, si := range activeSessions {
				sessionInfos[i] = SessionInfo{
					SessionID:        si.ID,
					Name:             si.Name,
					Status:           si.Status,
					WorkingDirectory: si.WorkingDirectory,
					CreatedAt:        si.CreatedAt,
					LastActivityAt:   si.LastActivityAt,
				}
			}
			writeMu.Lock()
			_ = conn.WriteMessage(websocket.TextMessage, NewSessionListMessage(sessionInfos))
			writeMu.Unlock()

		case "reattach_session":
			var reattachData wsReattachSessionData
			if err := json.Unmarshal(msg.Data, &reattachData); err != nil {
				log.Printf("Invalid reattach session data: %v", err)
				continue
			}

			// Reattach to the existing session
			ptySession, err := s.ptyManager.ReattachSession(reattachData.SessionID)
			if err != nil {
				log.Printf("Failed to reattach session %s: %v", reattachData.SessionID, err)
				errorData, _ := json.Marshal(map[string]string{
					"error": err.Error(),
				})
				writeMu.Lock()
				_ = conn.WriteJSON(wsMessage{
					Type:      "error",
					SessionID: reattachData.SessionID,
					Data:      errorData,
				})
				writeMu.Unlock()
				continue
			}

			// Resize PTY to match client dimensions
			if reattachData.Rows > 0 && reattachData.Cols > 0 {
				_ = ptySession.Resize(reattachData.Rows, reattachData.Cols)
			}

			// Track this session as attached to this connection
			asMu.Lock()
			attachedSessions[reattachData.SessionID] = struct{}{}
			asMu.Unlock()

			// Send session_reattached confirmation
			dir := ""
			if ptySession.Cmd != nil {
				dir = ptySession.Cmd.Dir
			}
			writeMu.Lock()
			_ = conn.WriteMessage(websocket.TextMessage,
				NewSessionReattachedMessage(reattachData.SessionID, dir, ""))
			writeMu.Unlock()

			// Send buffered scrollback output
			scrollback := ptySession.OutputBuffer.ReadAll()
			if len(scrollback) > 0 {
				writeMu.Lock()
				_ = conn.WriteMessage(websocket.TextMessage,
					NewScrollbackMessage(reattachData.SessionID, string(scrollback)))
				writeMu.Unlock()
			}

			// Set the attached writer so live output flows to this WebSocket
			attachWriter(reattachData.SessionID)

		case "create_session":
			var createData wsCreateSessionData
			if err := json.Unmarshal(msg.Data, &createData); err != nil {
				log.Printf("Invalid create session data: %v", err)
				continue
			}

			// Create new PTY session with client-provided ID
			ptySession, err := s.ptyManager.CreateSessionWithID(
				createData.SessionID,
				session.UserID,
				createData.Rows,
				createData.Cols,
			)
			if err != nil {
				log.Printf("Failed to create PTY session: %v", err)
				errorData, _ := json.Marshal(map[string]string{
					"error": err.Error(),
				})
				writeMu.Lock()
				_ = conn.WriteJSON(wsMessage{
					Type:      "error",
					SessionID: createData.SessionID,
					Data:      errorData,
				})
				writeMu.Unlock()
				continue
			}

			// Set session name if provided (T023)
			if createData.Name != "" {
				_ = s.ptyManager.SetSessionName(createData.SessionID, createData.Name)
			}

			// Track this session as attached to this connection
			asMu.Lock()
			attachedSessions[createData.SessionID] = struct{}{}
			asMu.Unlock()

			// Set attached writer for live output
			attachWriter(createData.SessionID)

			// Start persistent output reader goroutine (T024).
			// This reader lives for the lifetime of the session, not the WebSocket connection.
			// It always writes to the ring buffer; the attached writer forwards to WebSocket when set.
			ptySession.StartOutputReader(
				// onOutput: called on each chunk — forward to attached writer.
				// Don't record PTY output as activity - background processes
				// and shell prompts would prevent idle shutdown.
				func(sessionID string, data []byte) {
					sess := s.ptyManager.GetSession(sessionID)
					if sess == nil {
						return
					}
					writer := sess.GetAttachedWriter()
					if writer != nil {
						if _, err := writer.Write(data); err != nil {
							log.Printf("Attached writer error for session %s: %v", sessionID, err)
							// Clear the writer on error (WebSocket likely disconnected)
							sess.SetAttachedWriter(nil)
						}
					}
				},
				// onExit: called when process exits
				func(sessionID string) {
					closedData, _ := json.Marshal(map[string]interface{}{
						"sessionId": sessionID,
						"reason":    "process_exit",
					})
					sess := s.ptyManager.GetSession(sessionID)
					if sess == nil {
						return
					}
					writer := sess.GetAttachedWriter()
					if writer != nil {
						// Try to notify the attached WebSocket about process exit
						if wsW, ok := writer.(*wsWriter); ok {
							wsW.writeMu.Lock()
							_ = wsW.conn.WriteJSON(wsMessage{
								Type:      "session_closed",
								SessionID: sessionID,
								Data:      closedData,
							})
							wsW.writeMu.Unlock()
						}
					}
				},
			)

			// Send session created confirmation
			createdData, _ := json.Marshal(map[string]interface{}{
				"sessionId":        createData.SessionID,
				"workingDirectory": ptySession.Cmd.Dir,
			})
			writeMu.Lock()
			_ = conn.WriteJSON(wsMessage{
				Type:      "session_created",
				SessionID: createData.SessionID,
				Data:      createdData,
			})
			writeMu.Unlock()

		case "close_session":
			var closeData wsCloseSessionData
			if err := json.Unmarshal(msg.Data, &closeData); err != nil {
				log.Printf("Invalid close session data: %v", err)
				continue
			}

			// Remove from attached set and close the session permanently
			asMu.Lock()
			delete(attachedSessions, closeData.SessionID)
			asMu.Unlock()

			s.ptyManager.CloseSession(closeData.SessionID)

			// Send confirmation
			closedData, _ := json.Marshal(map[string]interface{}{
				"sessionId": closeData.SessionID,
				"reason":    "user_requested",
			})
			writeMu.Lock()
			_ = conn.WriteJSON(wsMessage{
				Type:      "session_closed",
				SessionID: closeData.SessionID,
				Data:      closedData,
			})
			writeMu.Unlock()

		case "input":
			// Route input to specific session via the global Manager
			sessionID := msg.SessionID
			if sessionID == "" {
				// Fallback to first attached session for backward compatibility
				asMu.Lock()
				for id := range attachedSessions {
					sessionID = id
					break
				}
				asMu.Unlock()
			}

			var input wsInputData
			if err := json.Unmarshal(msg.Data, &input); err != nil {
				log.Printf("Invalid input data: %v", err)
				continue
			}

			ptySession := s.ptyManager.GetSession(sessionID)
			if ptySession != nil {
				s.idleDetector.RecordActivity()
				if _, err := ptySession.Write([]byte(input.Data)); err != nil {
					log.Printf("PTY write error: %v", err)
				}
			}

		case "resize":
			// Route resize to specific session via the global Manager
			sessionID := msg.SessionID
			if sessionID == "" {
				asMu.Lock()
				for id := range attachedSessions {
					sessionID = id
					break
				}
				asMu.Unlock()
			}

			var resize wsResizeData
			if err := json.Unmarshal(msg.Data, &resize); err != nil {
				log.Printf("Invalid resize data: %v", err)
				continue
			}

			ptySession := s.ptyManager.GetSession(sessionID)
			if ptySession != nil {
				if err := ptySession.Resize(resize.Rows, resize.Cols); err != nil {
					log.Printf("PTY resize error: %v", err)
				}
			}

		case "rename_session":
			var renameData wsRenameSessionData
			if err := json.Unmarshal(msg.Data, &renameData); err != nil {
				log.Printf("Invalid rename session data: %v", err)
				continue
			}

			// Store name on the session in the global Manager
			_ = s.ptyManager.SetSessionName(renameData.SessionID, renameData.Name)

			// Send confirmation
			renamedData, _ := json.Marshal(map[string]interface{}{
				"sessionId": renameData.SessionID,
				"name":      renameData.Name,
			})
			writeMu.Lock()
			_ = conn.WriteJSON(wsMessage{
				Type:      "session_renamed",
				SessionID: renameData.SessionID,
				Data:      renamedData,
			})
			writeMu.Unlock()

		case "ping":
			// Don't record activity for pings - they're automatic heartbeats
			// sent every 30s regardless of user interaction
			writeMu.Lock()
			_ = conn.WriteJSON(wsMessage{Type: "pong", SessionID: msg.SessionID})
			writeMu.Unlock()

		default:
			log.Printf("Unknown message type: %s", msg.Type)
		}
	}
}
