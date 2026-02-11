package server

import (
	"context"
	"log"
	"net/http"

	"github.com/workspace/vm-agent/internal/acp"
)

// handleAgentWS handles WebSocket connections for ACP agent communication.
// Authentication uses the same JWT mechanism as the terminal WebSocket.
// Only one ACP session is allowed per workspace — new connections take over
// from existing ones (closing the old WebSocket) instead of being rejected.
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

	// Takeover pattern: if an existing ACP session is active, close it
	// gracefully to allow the new connection. This handles page refreshes,
	// tab closes, and network interruptions where the old goroutine is
	// still blocking in gateway.Run().
	s.acpMu.Lock()
	if s.acpGateway != nil {
		log.Printf("ACP: closing existing session for takeover by new connection")
		s.acpGateway.Close()
		s.acpGateway = nil
	}
	s.acpMu.Unlock()

	// Upgrade to WebSocket with origin validation
	upgrader := s.createUpgrader()
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ACP WebSocket upgrade failed: %v", err)
		return
	}

	log.Printf("ACP WebSocket connected: user=%s, workspace=%s", session.UserID, s.config.WorkspaceID)

	// Record activity for idle detection
	s.idleDetector.RecordActivity()

	// Create and register the ACP gateway
	gateway := acp.NewGateway(s.acpConfig, conn)

	s.acpMu.Lock()
	s.acpGateway = gateway
	s.acpMu.Unlock()

	// Run blocks until the WebSocket closes or the gateway is closed
	gateway.Run(context.Background())

	// Deregister the gateway (only if it's still ours — another takeover may
	// have already replaced it)
	s.acpMu.Lock()
	if s.acpGateway == gateway {
		s.acpGateway = nil
	}
	s.acpMu.Unlock()

	log.Printf("ACP WebSocket disconnected: user=%s", session.UserID)
}
