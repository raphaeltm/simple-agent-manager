package server

import (
	"context"
	"log"
	"net/http"

	"github.com/workspace/vm-agent/internal/acp"
)

// handleAgentWS handles WebSocket connections for ACP agent communication.
// Authentication uses the same JWT mechanism as the terminal WebSocket.
// Only one ACP session is allowed per workspace (T051).
func (s *Server) handleAgentWS(w http.ResponseWriter, r *http.Request) {
	// Check authentication — same as terminal WebSocket
	session := s.sessionManager.GetSessionFromRequest(r)
	if session == nil {
		// Try token from query param (for initial connection)
		token := r.URL.Query().Get("token")
		if token != "" {
			claims, err := s.jwtValidator.Validate(token)
			if err != nil {
				log.Printf("ACP WebSocket auth failed: %v", err)
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
			session, err = s.sessionManager.CreateSession(claims)
			if err != nil {
				log.Printf("Failed to create session for ACP: %v", err)
				http.Error(w, "Internal Server Error", http.StatusInternalServerError)
				return
			}
		} else {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
	}

	// Enforce single ACP session per workspace
	s.acpMu.Lock()
	if s.acpActive {
		s.acpMu.Unlock()
		http.Error(w, "Another ACP session is already active", http.StatusConflict)
		return
	}
	s.acpActive = true
	s.acpMu.Unlock()

	defer func() {
		s.acpMu.Lock()
		s.acpActive = false
		s.acpMu.Unlock()
	}()

	// Upgrade to WebSocket with origin validation
	upgrader := s.createUpgrader()
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ACP WebSocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	log.Printf("ACP WebSocket connected: user=%s, workspace=%s", session.UserID, s.config.WorkspaceID)

	// Record activity for idle detection
	s.idleDetector.RecordActivity()

	// Create and run the ACP gateway
	gateway := acp.NewGateway(s.acpConfig, conn)
	gateway.Run(context.Background())

	log.Printf("ACP WebSocket disconnected: user=%s", session.UserID)
}
