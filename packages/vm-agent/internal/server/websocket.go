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

// WebSocket message types
type wsMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

type wsInputData struct {
	Data string `json:"data"`
}

type wsResizeData struct {
	Rows int `json:"rows"`
	Cols int `json:"cols"`
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
		if _, err := json.Unmarshal([]byte(r.URL.Query().Get("rows")), &rows); err != nil {
			rows = 24
		}
	}
	if r.URL.Query().Get("cols") != "" {
		if _, err := json.Unmarshal([]byte(r.URL.Query().Get("cols")), &cols); err != nil {
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
				s.idleDetector.RecordActivity()
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
			s.idleDetector.RecordActivity()
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
